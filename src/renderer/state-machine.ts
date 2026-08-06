import { TransferState } from '../shared/types';

export class AppStateMachine {
  private state: TransferState = 'idle';

  public getState() { return this.state; }

  public transition(action: 'SELECT' | 'CANCEL' | 'START' | 'PAUSE' | 'RESUME' | 'START_LOOPBACK' | 'ERROR' | 'START_RECEIVE' | 'RECEIVE_SUCCESS') {
    switch (this.state) {
      case 'idle':
      case 'failed':
        if (action === 'SELECT') this.state = 'selecting-file';
        else if (action === 'START_RECEIVE') this.state = 'receive-camera' as any; // Cast temporarily since we haven't updated types.ts fully for 'receive-camera' or we can just use 'verifying'
        break;
      case 'selecting-file':
        if (action === 'ERROR' || action === 'CANCEL') this.state = 'idle';
        else if (action === 'SELECT') this.state = 'file-selected';
        break;
      case 'file-selected':
        if (action === 'START') this.state = 'preparing';
        else if (action === 'START_LOOPBACK') this.state = 'loopback-receiving';
        else if (action === 'CANCEL') this.state = 'idle';
        break;
      case 'preparing':
        if (action === 'START') this.state = 'streaming';
        else if (action === 'ERROR') this.state = 'failed';
        break;
      case 'streaming':
        if (action === 'PAUSE') this.state = 'paused';
        else if (action === 'CANCEL') this.state = 'idle';
        break;
      case 'paused':
        if (action === 'RESUME') this.state = 'streaming';
        else if (action === 'CANCEL') this.state = 'idle';
        break;
      case 'loopback-receiving':
      case 'receive-camera':
        if (action === 'CANCEL') this.state = 'idle';
        else if (action === 'RECEIVE_SUCCESS') this.state = 'verified';
        break;
      case 'verified':
        if (action === 'CANCEL') this.state = 'idle';
        break;
    }
    return this.state;
  }
}
