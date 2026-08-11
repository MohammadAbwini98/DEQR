/// <reference types="vite/client" />
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { FountainDecoder } from '../../core/fountain-decoder';
import { deserializeFrame } from '../../core/protocol';
import { SafeDisplayMetadata } from '../../shared/types';
// Vite syntax for worker
import DecoderWorker from '../workers/decoder.worker?worker';

interface Props {
  onCancel: () => void;
  onVerified: (payload: Uint8Array, metadata: SafeDisplayMetadata) => void;
}

export default function CameraReceiver({ onCancel, onVerified }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const animationRef = useRef<number>(0);
  
  const decoderRef = useRef<FountainDecoder>(new FountainDecoder());
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string>('');
  
  const [receivedFrames, setReceivedFrames] = useState(0);
  const [recoveredBlocks, setRecoveredBlocks] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isCaptureActive, setIsCaptureActive] = useState(false);
  const [cameraStatus, setCameraStatus] = useState<'checking' | 'ready' | 'active' | 'denied' | 'unavailable' | 'error'>('checking');

  // Initialize Worker and MediaDevices
  useEffect(() => {
    workerRef.current = new DecoderWorker();
    workerRef.current.onmessage = (e) => {
      setIsProcessing(false);
      const { type, binaryData } = e.data;
      if (type === 'DECODE_SUCCESS' && binaryData) {
        handleFrameDecoded(binaryData);
      }
    };

    navigator.mediaDevices.enumerateDevices().then(devices => {
      const videoDevices = devices.filter(d => d.kind === 'videoinput');
      setCameras(videoDevices);
      if (videoDevices.length > 0) {
        setSelectedCameraId(videoDevices[videoDevices.length - 1].deviceId);
        setCameraStatus('ready');
      } else {
        setCameraStatus('unavailable');
      }
    }).catch(() => setCameraStatus('error'));

    return () => {
      if (workerRef.current) {
        workerRef.current.onmessage = null;
        workerRef.current.terminate();
        workerRef.current = null;
      }
      cancelAnimationFrame(animationRef.current);
    };
  }, []);

  // Acquire the camera only after the person explicitly starts reception.
  useEffect(() => {
    if (!isCaptureActive || !selectedCameraId) return;

    let currentStream: MediaStream | null = null;
    
    const startStream = async () => {
      try {
        currentStream = await navigator.mediaDevices.getUserMedia({
          video: selectedCameraId ? {
            deviceId: { exact: selectedCameraId },
            width: { ideal: 1280 },
            height: { ideal: 720 },
            facingMode: 'environment'
          } : { facingMode: 'environment' }
        });
        
        if (videoRef.current) {
          videoRef.current.srcObject = currentStream;
          await videoRef.current.play();
        }
        setCameraStatus('active');
      } catch (err: any) {
        if (err.name === 'NotAllowedError') {
          setCameraStatus('denied');
        } else if (err.name === 'NotFoundError') {
          setCameraStatus('unavailable');
        } else {
          setCameraStatus('error');
        }
        setIsCaptureActive(false);
      }
    };
    
    startStream();

    return () => {
      if (currentStream) {
        currentStream.getTracks().forEach(track => {
          track.enabled = false;
          track.stop();
        });
      }
      if (videoRef.current) {
        videoRef.current.pause();
        videoRef.current.srcObject = null;
      }
    };
  }, [isCaptureActive, selectedCameraId]);

  const handleFrameDecoded = useCallback((binaryData: Uint8Array) => {
    try {
      const frame = deserializeFrame(Buffer.from(binaryData));
      const isComplete = decoderRef.current.receiveFrame(frame);
      setReceivedFrames(prev => prev + 1);
      setRecoveredBlocks(decoderRef.current.getSolvedCount());

      if (isComplete) {
        // We pass the full container buffer up. Main process will deserialize it and verify hash.
        const containerBuffer = decoderRef.current.reconstructPayload();
        
        onVerified(containerBuffer, { 
          filename: 'received_transfer.deqr', // This is a placeholder; Main extracts the real one
          size: containerBuffer.length, 
          compressed: false, 
          mimeType: 'application/octet-stream', 
          extension: '.deqr' 
        });
      }
    } catch (e) {
      console.warn('Frame processing failed', e);
    }
  }, [onVerified]);

  const stopCapture = () => {
    setIsProcessing(false);
    setIsCaptureActive(false);
    setCameraStatus((currentStatus) => currentStatus === 'active' ? 'ready' : currentStatus);
  };

  // Main capture loop
  const captureLoop = useCallback(() => {
    if (isCaptureActive && videoRef.current && canvasRef.current && !isProcessing) {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          
          setIsProcessing(true);
          workerRef.current?.postMessage({
            type: 'DECODE',
            id: Date.now(),
            imageData: imageData.data,
            width: imageData.width,
            height: imageData.height
          });
        }
      }
    }
    
    animationRef.current = requestAnimationFrame(captureLoop);
  }, [isCaptureActive, isProcessing]);

  useEffect(() => {
    animationRef.current = requestAnimationFrame(captureLoop);
    return () => cancelAnimationFrame(animationRef.current);
  }, [captureLoop]);

  return (
    <section className="card" aria-labelledby="receive-title">
      <h2 id="receive-title">Receive Transfer</h2>
      <p style={{ color: 'var(--text-secondary)' }}>
        Start the camera only when you are ready to scan a local DEQR QR stream.
      </p>
      
      {cameras.length > 1 && (
        <label>
          Camera
          <select
            value={selectedCameraId}
            onChange={(e) => setSelectedCameraId(e.target.value)}
            disabled={isCaptureActive}
            style={{ display: 'block', marginTop: '6px', padding: '8px' }}
          >
            {cameras.map(c => <option key={c.deviceId} value={c.deviceId}>{c.label || 'Camera'}</option>)}
          </select>
        </label>
      )}

      <div className="camera-surface" aria-label="Camera preview and QR alignment area">
        <video ref={videoRef} playsInline muted aria-hidden="true" style={{ display: 'none' }}></video>
        <canvas ref={canvasRef} aria-label="Live camera preview"></canvas>
        <div className="camera-alignment-guide" aria-hidden="true"></div>
      </div>

      <div className={`status-message${cameraStatus === 'denied' || cameraStatus === 'unavailable' || cameraStatus === 'error' ? ' error' : ''}`} role={cameraStatus === 'denied' || cameraStatus === 'unavailable' || cameraStatus === 'error' ? 'alert' : 'status'}>
        {cameraStatus === 'checking' && 'Checking for an available camera…'}
        {cameraStatus === 'ready' && 'Camera is ready. Select Start Camera to begin capture.'}
        {cameraStatus === 'active' && 'Camera capture is active. Keep the sender QR inside the alignment guide.'}
        {cameraStatus === 'denied' && 'Camera access was denied. Allow camera access in system settings, then try again.'}
        {cameraStatus === 'unavailable' && 'No compatible camera is available.'}
        {cameraStatus === 'error' && 'The camera could not be started. Check the camera and try again.'}
      </div>
      
      <div style={{ width: '100%', marginTop: '16px', display: 'flex', justifyContent: 'space-between' }}>
        <div>
          <strong>Received Frames:</strong> {receivedFrames}
        </div>
        <div>
          <strong>Recovered Blocks:</strong> {recoveredBlocks}
        </div>
      </div>

      <div className="button-row">
        {!isCaptureActive ? (
          <button className="primary" onClick={() => setIsCaptureActive(true)} disabled={!selectedCameraId || cameraStatus === 'unavailable'}>
            Start Camera
          </button>
        ) : (
          <button onClick={stopCapture}>Stop Camera</button>
        )}
        <button className="danger" onClick={onCancel}>Cancel Reception</button>
      </div>
    </section>
  );
}
