import { describe, expect, it } from 'vitest';
import { createCameraConstraints, describeCameraFailure } from '../../src/renderer/camera-model';

describe('camera permission model', () => {
  it('requests the environment-facing camera before device labels are available', () => {
    expect(createCameraConstraints('', false)).toMatchObject({
      facingMode: { ideal: 'environment' },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    });
  });

  it('uses an exact selected device only after permission has been granted', () => {
    expect(createCameraConstraints('rear-camera', true)).toMatchObject({
      deviceId: { exact: 'rear-camera' },
    });
    expect(createCameraConstraints('rear-camera', false)).not.toHaveProperty('deviceId');
  });

  it('provides inline recovery guidance for denied and unavailable cameras', () => {
    expect(describeCameraFailure({ name: 'NotAllowedError' })).toMatchObject({ status: 'denied' });
    expect(describeCameraFailure({ name: 'NotFoundError' })).toMatchObject({ status: 'unavailable' });
    expect(describeCameraFailure({ name: 'NotReadableError' }).message).toContain('other camera apps');
  });
});
