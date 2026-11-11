import type {
  ControlErrorData,
  ControlFieldFault,
  ControlLauncherNotifications,
  ControlMethod,
  ControlMethods,
} from '../../electron/control-types.gen';
import type { OllamaInfo } from './ollama-info';

/** A control request's params as a caller gives them: every member but `apiVersion`, which
 *  Desktop's control client states. */
export type ControlRequestParams<M extends ControlMethod> = Omit<ControlMethods[M]['params'], 'apiVersion'>;

/** A notification the launcher sends about a request, of one of the methods `N`. */
export type ControlNoticeOf<N extends keyof ControlLauncherNotifications> = {
  [K in N]: { method: K; params: ControlLauncherNotifications[K] };
}[N];

/** A notification the launcher sent about a request: its narration, a code a person must
 *  enter, or a line a followed service wrote. */
export type ControlNotice = ControlNoticeOf<keyof ControlLauncherNotifications>;

/** Why a control request has no result. */
export type ControlFailure =
  /** The launcher answered it with an error. */
  | { kind: 'answered'; code: number; message: string; data?: ControlErrorData }
  /** Desktop refused its params before sending them, as the launcher refuses them. */
  | { kind: 'refused'; code: number; message: string; data: ControlErrorData }
  /** A message the launcher sent about it does not hold to its schema. */
  | { kind: 'mismatch'; message: string; schema: string; faults: ControlFieldFault[] }
  /** The launcher's control stream broke the protocol, and every request in flight on it
   *  was given up. */
  | { kind: 'protocol'; message: string }
  /** The launcher exited, or could not be run, before it answered. */
  | { kind: 'exited'; message: string }
  /** Desktop's control client was closed: Desktop is quitting. */
  | { kind: 'closed'; message: string };

/** A control request's answer, as it crosses to the renderer. */
export type ControlOutcome<M extends ControlMethod> =
  | { ok: true; result: ControlMethods[M]['result'] }
  | { ok: false; error: ControlFailure };

/** What the renderer hears of a request it started: each notification, then its answer. */
export type ControlEvent<M extends ControlMethod> =
  | { kind: 'notification'; notice: ControlNotice }
  | { kind: 'answer'; outcome: ControlOutcome<M> };

/** The renderer's name for one of its control requests. */
export type ControlHandle = number;

/** A view's state of one control request it shows the answer of. */
export type ControlAnswerState<M extends ControlMethod> =
  | { status: 'loading' }
  /** There is no launcher bridge: the web build. */
  | { status: 'unavailable' }
  | { status: 'answered'; outcome: ControlOutcome<M> };

/** The channel a request's events reach the renderer on. */
export function controlEventChannel(handle: ControlHandle): string {
  return `control:event:${handle}`;
}

/** A failure as a person reads it. */
export function controlFailureText(failure: ControlFailure): string {
  switch (failure.kind) {
    case 'answered':
    case 'refused':
      return failure.data === undefined ? failure.message : `${failure.message} (${failure.data.code})`;
    case 'mismatch':
    case 'protocol':
    case 'exited':
    case 'closed':
      return failure.message;
  }
}

export interface McpProcessStatus {
  state: 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';
  pid: number | null;
  startedAt: number | null;
  memoryBytes: number | null;
  cpuPercent: number | null;
  error: string | null;
}

export interface LauncherBridge {
  /** Send a request of the launcher's control API (protocol/specs/src/control/methods.json).
   *  `listener` hears each of its notifications, then its answer. Resolves with its handle
   *  once the main process has taken it; rejects when what it was handed is no request. */
  startControl<M extends ControlMethod>(
    method: M,
    params: ControlRequestParams<M>,
    listener: (event: ControlEvent<M>) => void,
  ): Promise<ControlHandle>;
  /** Give up on a request: the launcher answers it with control.cancelled, unless it has
   *  answered it already. */
  cancelControl(handle: ControlHandle, reason: string): void;
  chooseDirectory(): Promise<string | null>;
  gitPath(): Promise<string | null>;
  opPath(): Promise<string | null>;
  ollamaInfo(): Promise<OllamaInfo>;
  mcpStatus(): Promise<McpProcessStatus>;
  startMcp(): Promise<McpProcessStatus>;
  stopMcp(): Promise<McpProcessStatus>;
}
