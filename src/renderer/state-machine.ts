import { TransferState } from '../shared/types';

export class AppStateMachine {
  private state: TransferState = 'idle';

  public getState() { return this.state; }

  public transition(action: 'SELECT' | 'CANCEL' | 'START' | 'PAUSE' | 'RESUME' | 'START_LOOPBACK' | 'ERROR') {
    switch (this.state) {
      case 'idle':
      case 'failed':
        if (action === 'SELECT') this.state = 'selecting-file';
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
        if (action === 'CANCEL') this.state = 'idle';
        break;
    }
    return this.state;
  }
}
