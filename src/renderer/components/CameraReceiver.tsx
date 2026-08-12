/// <reference types="vite/client" />
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FountainDecoder } from '../../core/fountain-decoder';
import { deserializeFrame } from '../../core/protocol';
import { SafeDisplayMetadata } from '../../shared/types';
import { CameraStatus, createCameraConstraints, describeCameraFailure } from '../camera-model';
import DecoderWorker from '../workers/decoder.worker?worker';

interface Props {
  onCancel: () => void;
  onVerified: (payload: Uint8Array, metadata: SafeDisplayMetadata) => void;
}

interface ReceiverMetrics {
  receivedFrames: number;
  recoveredBlocks: number;
}

const INITIAL_METRICS: ReceiverMetrics = { receivedFrames: 0, recoveredBlocks: 0 };

export default function CameraReceiver({ onCancel, onVerified }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animationRef = useRef<number>(0);
  const processingRef = useRef(false);
  const activeRef = useRef(false);
  const mountedRef = useRef(true);
  const decoderRef = useRef(new FountainDecoder());
  const metricsRef = useRef<ReceiverMetrics>(INITIAL_METRICS);
  const metricsTimerRef = useRef<number | undefined>(undefined);
  const decodedHandlerRef = useRef<(binaryData: Uint8Array) => void>(() => undefined);
  const captureLoopRef = useRef<() => void>(() => undefined);
  const onVerifiedRef = useRef(onVerified);

  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState('');
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [cameraStatus, setCameraStatus] = useState<CameraStatus>('idle');
  const [cameraMessage, setCameraMessage] = useState('Camera access has not been requested.');
  const [metrics, setMetrics] = useState<ReceiverMetrics>(INITIAL_METRICS);

  useEffect(() => {
    onVerifiedRef.current = onVerified;
  }, [onVerified]);

  const stopMedia = useCallback(() => {
    activeRef.current = false;
    processingRef.current = false;
    if (animationRef.current) {
      window.cancelAnimationFrame(animationRef.current);
      animationRef.current = 0;
    }
    streamRef.current?.getTracks().forEach((track) => {
      track.enabled = false;
      track.stop();
    });
    streamRef.current = null;
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
    }
  }, []);

  const publishMetrics = useCallback(() => {
    if (metricsTimerRef.current !== undefined) {
      window.clearTimeout(metricsTimerRef.current);
      metricsTimerRef.current = undefined;
    }
    if (mountedRef.current) setMetrics({ ...metricsRef.current });
  }, []);

  const queueMetrics = useCallback((recoveredBlocks: number) => {
    metricsRef.current = {
      receivedFrames: metricsRef.current.receivedFrames + 1,
      recoveredBlocks,
    };
    if (metricsTimerRef.current === undefined) {
      metricsTimerRef.current = window.setTimeout(publishMetrics, 200);
    }
  }, [publishMetrics]);

  const handleFrameDecoded = useCallback((binaryData: Uint8Array) => {
    if (!activeRef.current) return;
    try {
      const frame = deserializeFrame(Buffer.from(binaryData));
      const isComplete = decoderRef.current.receiveFrame(frame);
      queueMetrics(decoderRef.current.getSolvedCount());

      if (isComplete) {
        const containerBuffer = decoderRef.current.reconstructPayload();
        publishMetrics();
        stopMedia();
        onVerifiedRef.current(containerBuffer, {
          filename: 'received_transfer.deqr',
          size: containerBuffer.length,
          compressed: false,
          mimeType: 'application/octet-stream',
          extension: '.deqr',
        });
      }
    } catch {
      // Invalid or unrelated camera frames are expected while scanning.
    }
  }, [publishMetrics, queueMetrics, stopMedia]);

  useEffect(() => {
    decodedHandlerRef.current = handleFrameDecoded;
  }, [handleFrameDecoded]);

  captureLoopRef.current = () => {
    if (!activeRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;

    if (video && canvas && !processingRef.current && video.readyState >= video.HAVE_CURRENT_DATA) {
      if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (context && canvas.width > 0 && canvas.height > 0) {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
        processingRef.current = true;
        workerRef.current?.postMessage({
          type: 'DECODE',
          id: Date.now(),
          imageData: imageData.data,
          width: imageData.width,
          height: imageData.height,
        });
        if (!workerRef.current) processingRef.current = false;
      }
    }

    animationRef.current = window.requestAnimationFrame(() => captureLoopRef.current());
  };

  useEffect(() => {
    mountedRef.current = true;
    const worker = new DecoderWorker();
    workerRef.current = worker;
    worker.onmessage = (event) => {
      processingRef.current = false;
      const { type, binaryData } = event.data as { type?: string; binaryData?: Uint8Array };
      if (type === 'DECODE_SUCCESS' && binaryData) decodedHandlerRef.current(binaryData);
    };
    worker.onerror = () => {
      processingRef.current = false;
      if (mountedRef.current && activeRef.current) {
        stopMedia();
        setCameraStatus('error');
        setCameraMessage('Camera decoding stopped unexpectedly. Start the camera again to retry.');
      }
    };

    return () => {
      mountedRef.current = false;
      stopMedia();
      if (metricsTimerRef.current !== undefined) window.clearTimeout(metricsTimerRef.current);
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      workerRef.current = null;
    };
  }, [stopMedia]);

  const startCamera = async () => {
    stopMedia();
    decoderRef.current = new FountainDecoder();
    metricsRef.current = INITIAL_METRICS;
    setMetrics(INITIAL_METRICS);
    setCameraStatus('requesting');
    setCameraMessage('Waiting for camera permission.');

    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraStatus('unavailable');
      setCameraMessage('Camera access is unavailable in this environment.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: createCameraConstraints(selectedCameraId, permissionGranted),
      });
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) throw new Error('Camera preview is unavailable.');
      video.srcObject = stream;
      await video.play();

      setPermissionGranted(true);
      const deviceId = stream.getVideoTracks()[0]?.getSettings().deviceId;
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter((device) => device.kind === 'videoinput');
        if (mountedRef.current) {
          setCameras(videoDevices);
          if (deviceId && videoDevices.some((device) => device.deviceId === deviceId)) {
            setSelectedCameraId(deviceId);
          }
        }
      } catch {
        // The active facing-mode stream remains usable if enumeration is unavailable.
      }

      activeRef.current = true;
      setCameraStatus('active');
      setCameraMessage('Camera active. Hold the animated QR code inside the guide.');
      animationRef.current = window.requestAnimationFrame(() => captureLoopRef.current());
    } catch (caught) {
      stopMedia();
      if (!mountedRef.current) return;
      const failure = describeCameraFailure(caught);
      setCameraStatus(failure.status);
      setCameraMessage(failure.message);
    }
  };

  const stopCamera = () => {
    stopMedia();
    setCameraStatus('idle');
    setCameraMessage('Camera stopped. Start it again when you are ready.');
  };

  const isError = cameraStatus === 'denied' || cameraStatus === 'unavailable' || cameraStatus === 'error';
  const canStart = cameraStatus === 'idle' || isError;

  return (
    <section className="receiver-view" aria-labelledby="receiver-heading">
      <header className="section-heading">
        <p className="eyebrow">Desktop receiver</p>
        <h1 id="receiver-heading" data-screen-heading tabIndex={-1}>Scan an optical stream</h1>
        <p>The camera stays off until you start it. A reconstructed container must pass main-process verification before a save can be reported.</p>
      </header>

      {permissionGranted && cameras.length > 1 && (
        <label className="camera-select-label">
          <span>Camera</span>
          <select
            value={selectedCameraId}
            onChange={(event) => setSelectedCameraId(event.target.value)}
            disabled={cameraStatus === 'active' || cameraStatus === 'requesting'}
          >
            {cameras.map((camera, index) => (
              <option key={camera.deviceId} value={camera.deviceId}>{camera.label || `Camera ${index + 1}`}</option>
            ))}
          </select>
        </label>
      )}

      <p className={isError ? 'camera-status error-banner' : 'camera-status'} role={isError ? 'alert' : 'status'} aria-live="polite">
        {cameraMessage}
      </p>

      <div className={`camera-stage camera-stage--${cameraStatus}`}>
        <video ref={videoRef} playsInline muted className="visually-hidden" aria-hidden="true" />
        <canvas ref={canvasRef} className="camera-canvas" aria-label="Live camera preview for DEQR QR scanning" />
        <div className="camera-guide" aria-hidden="true" />
        {cameraStatus !== 'active' && <p className="camera-placeholder" aria-hidden="true">Camera preview is off</p>}
      </div>

      <dl className="receiver-metrics" aria-label="Receiver metrics">
        <div><dt>Frames received</dt><dd>{metrics.receivedFrames}</dd></div>
        <div><dt>Blocks recovered</dt><dd>{metrics.recoveredBlocks}</dd></div>
      </dl>

      <div className="action-row">
        {canStart && <button className="primary" onClick={startCamera}>{isError ? 'Try camera again' : 'Start camera'}</button>}
        {cameraStatus === 'requesting' && <button className="primary" disabled>Requesting camera…</button>}
        {cameraStatus === 'active' && <button className="secondary" onClick={stopCamera}>Stop camera</button>}
        <button className="danger" onClick={onCancel}>Cancel reception</button>
      </div>
    </section>
  );
}
