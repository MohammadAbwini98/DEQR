import { PwaHostStateView, PwaHostStatusView } from '../shared/types';

/**
 * The renderer's own optimistic view of an action it just requested. Set before
 * awaiting the IPC reply, because the main process can be blocked generating a
 * certificate and cannot answer promptly on a first start.
 */
export type PwaHostPendingAction = 'starting' | 'stopping' | null;

export interface PwaHostPresentation {
  state: PwaHostStateView;
  message: string;
  hint: string | null;
  /** Only a real failure earns the degraded treatment. `stopped` is intended. */
  isFailure: boolean;
  showQr: boolean;
  actionLabel: string;
  actionKind: 'start' | 'stop';
  actionDisabled: boolean;
  actionClassName: 'primary' | 'secondary';
}

const STOPPED_HINT =
  'Start it when you want to install or open the receiver on an iPhone. Windows may ask to allow DEQR through the firewall the first time.';

const FAILED_HINT =
  'Connect this computer to the same network as the iPhone, or to your tailnet, then try again. If a development server is already using this port, stop it first.';

export interface ActionFocusRestore {
  /** The control held focus when the action was requested. */
  hadFocus: boolean;
  /** True while the transition is in flight and the control is disabled. */
  actionDisabled: boolean;
  /** Focus is sitting on `<body>`, i.e. it was dropped rather than moved. */
  activeIsBody: boolean;
}

/**
 * Whether focus has to be handed back to the start/stop control.
 *
 * The control is disabled while a transition is in flight, and a browser blurs
 * a disabled element to `<body>` and does not restore it on re-enable. Keeping
 * one non-remounted button was not enough on its own: a keyboard user who
 * pressed Enter still landed at the top of the document and had to tab back to
 * the button they had just used.
 *
 * Only a dropped focus is reclaimed. If someone moved focus somewhere else
 * while the receiver was starting, taking it back would be its own bug.
 */
export function shouldRestoreActionFocus(state: ActionFocusRestore): boolean {
  return state.hadFocus && !state.actionDisabled && state.activeIsBody;
}

export function presentPwaHost(
  status: PwaHostStatusView | null,
  pending: PwaHostPendingAction,
): PwaHostPresentation {
  // A pending action outranks the last known status: the status may be stale
  // while the request is in flight.
  const state: PwaHostStateView = pending ?? status?.state ?? 'stopped';

  if (status === null && pending === null) {
    return {
      state: 'stopped',
      message: 'Checking the iPhone receiver…',
      hint: null,
      isFailure: false,
      showQr: false,
      actionLabel: 'Start receiver',
      actionKind: 'start',
      actionDisabled: true,
      actionClassName: 'primary',
    };
  }

  if (state === 'starting') {
    return {
      state,
      message:
        'Starting the iPhone receiver… The first start also creates a certificate, which can take a few seconds.',
      hint: null,
      isFailure: false,
      showQr: false,
      actionLabel: 'Starting…',
      actionKind: 'start',
      actionDisabled: true,
      actionClassName: 'primary',
    };
  }

  if (state === 'stopping') {
    return {
      state,
      message: 'Stopping the iPhone receiver…',
      hint: null,
      isFailure: false,
      showQr: false,
      actionLabel: 'Stopping…',
      actionKind: 'stop',
      actionDisabled: true,
      actionClassName: 'secondary',
    };
  }

  if (state === 'failed') {
    return {
      state,
      message: status?.error ?? 'The iPhone receiver could not be started.',
      hint: FAILED_HINT,
      isFailure: true,
      showQr: false,
      actionLabel: 'Try again',
      actionKind: 'start',
      actionDisabled: false,
      actionClassName: 'primary',
    };
  }

  if (state === 'running') {
    // A running host with no LAN address is reachable only from this machine,
    // so a QR of that URL would send the phone somewhere it cannot go.
    const reachable = (status?.addresses.length ?? 0) > 0;
    return {
      state,
      message: reachable
        ? 'The iPhone receiver is running on this network.'
        : 'The receiver is running, but this computer has no address an iPhone can reach. Connect to Wi-Fi or your tailnet.',
      hint: null,
      isFailure: false,
      showQr: reachable,
      actionLabel: 'Stop receiver',
      actionKind: 'stop',
      actionDisabled: false,
      actionClassName: 'secondary',
    };
  }

  return {
    state: 'stopped',
    message:
      'The iPhone receiver is not running. Nothing on your network can reach this computer until you start it.',
    hint: STOPPED_HINT,
    isFailure: false,
    showQr: false,
    actionLabel: 'Start receiver',
    actionKind: 'start',
    actionDisabled: false,
    actionClassName: 'primary',
  };
}
