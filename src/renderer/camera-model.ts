export type CameraStatus = 'idle' | 'requesting' | 'active' | 'denied' | 'unavailable' | 'error';

export interface CameraFailure {
  status: Extract<CameraStatus, 'denied' | 'unavailable' | 'error'>;
  message: string;
}

export function createCameraConstraints(
  selectedCameraId: string,
  permissionGranted: boolean,
): MediaTrackConstraints {
  const base: MediaTrackConstraints = {
    width: { ideal: 1280 },
    height: { ideal: 720 },
  };

  if (permissionGranted && selectedCameraId) {
    return { ...base, deviceId: { exact: selectedCameraId } };
  }

  return { ...base, facingMode: { ideal: 'environment' } };
}

export function describeCameraFailure(error: unknown): CameraFailure {
  const name = error && typeof error === 'object' && 'name' in error
    ? String((error as { name?: unknown }).name)
    : '';

  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return {
      status: 'denied',
      message: 'Camera access was denied. Allow camera access in system settings, then try again.',
    };
  }

  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return {
      status: 'unavailable',
      message: 'No compatible camera is available. Connect or enable a camera, then try again.',
    };
  }

  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return {
      status: 'unavailable',
      message: 'The camera is already in use or unavailable. Close other camera apps, then try again.',
    };
  }

  return {
    status: 'error',
    message: 'The camera could not be started. Check the camera connection and permissions, then try again.',
  };
}
