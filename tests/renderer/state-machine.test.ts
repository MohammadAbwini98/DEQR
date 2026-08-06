import { describe, it, expect } from 'vitest';
import { AppStateMachine } from '../../src/renderer/state-machine';

describe('App State Machine', () => {
  it('starts idle', () => {
    const sm = new AppStateMachine();
    expect(sm.getState()).toBe('idle');
  });

  it('transitions properly to streaming', () => {
    const sm = new AppStateMachine();
    sm.transition('SELECT'); // -> selecting-file
    expect(sm.getState()).toBe('selecting-file');
    
    sm.transition('SELECT'); // -> file-selected
    expect(sm.getState()).toBe('file-selected');
    
    sm.transition('START'); // -> preparing
    expect(sm.getState()).toBe('preparing');
    
    sm.transition('START'); // -> streaming
    expect(sm.getState()).toBe('streaming');
  });

  it('handles pause and resume', () => {
    const sm = new AppStateMachine();
    sm.transition('SELECT');
    sm.transition('SELECT');
    sm.transition('START');
    sm.transition('START');
    expect(sm.getState()).toBe('streaming');
    
    sm.transition('PAUSE');
    expect(sm.getState()).toBe('paused');
    
    sm.transition('RESUME');
    expect(sm.getState()).toBe('streaming');
  });

  it('can be cancelled from streaming', () => {
    const sm = new AppStateMachine();
    sm.transition('SELECT');
    sm.transition('SELECT');
    sm.transition('START');
    sm.transition('START');
    
    sm.transition('CANCEL');
    expect(sm.getState()).toBe('idle');
  });
});
