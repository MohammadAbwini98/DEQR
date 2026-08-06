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
        setSelectedCameraId(videoDevices[videoDevices.length - 1].deviceId); // Prefer back camera (often last)
      }
    }).catch(err => console.error('Enumerate devices failed:', err));

    return () => {
      if (workerRef.current) {
        workerRef.current.onmessage = null;
        workerRef.current.terminate();
        workerRef.current = null;
      }
      cancelAnimationFrame(animationRef.current);
    };
  }, []);

  // Handle stream initialization when camera changes
  useEffect(() => {
    if (!selectedCameraId && cameras.length > 0) return;

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
          videoRef.current.play();
        }
      } catch (err: any) {
        if (err.name === 'NotAllowedError') {
          console.error('Camera permission denied.');
          alert('Camera permission is required to receive transfers.');
        } else if (err.name === 'NotFoundError') {
          console.error('No camera found.');
          alert('No compatible camera was found.');
        } else {
          console.error('Failed to start camera:', err);
        }
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
  }, [selectedCameraId, cameras.length]);

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

  // Main capture loop
  const captureLoop = useCallback(() => {
    if (videoRef.current && canvasRef.current && !isProcessing) {
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
  }, [isProcessing]);

  useEffect(() => {
    animationRef.current = requestAnimationFrame(captureLoop);
    return () => cancelAnimationFrame(animationRef.current);
  }, [captureLoop]);

  return (
    <div className="card" style={{ alignItems: 'center' }}>
      <h2>Receive Transfer</h2>
      
      {cameras.length > 1 && (
        <select 
          value={selectedCameraId} 
          onChange={(e) => setSelectedCameraId(e.target.value)}
          style={{ marginBottom: '16px', padding: '8px' }}
        >
          {cameras.map(c => <option key={c.deviceId} value={c.deviceId}>{c.label || 'Camera'}</option>)}
        </select>
      )}

      <div style={{ position: 'relative', width: '100%', maxWidth: '640px', background: '#000', borderRadius: '8px', overflow: 'hidden' }}>
        <video ref={videoRef} playsInline muted style={{ display: 'none' }}></video>
        <canvas ref={canvasRef} style={{ width: '100%', display: 'block' }}></canvas>
        {/* Alignment Overlay */}
        <div style={{ 
          position: 'absolute', top: '20%', left: '20%', right: '20%', bottom: '20%', 
          border: '2px dashed rgba(255, 255, 255, 0.5)', pointerEvents: 'none' 
        }}></div>
      </div>
      
      <div style={{ width: '100%', marginTop: '16px', display: 'flex', justifyContent: 'space-between' }}>
        <div>
          <strong>Received Frames:</strong> {receivedFrames}
        </div>
        <div>
          <strong>Recovered Blocks:</strong> {recoveredBlocks}
        </div>
      </div>

      <div style={{ marginTop: '16px', width: '100%' }}>
        <button className="danger" onClick={onCancel}>Cancel Reception</button>
      </div>
    </div>
  );
}
