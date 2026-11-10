import type { ReactNode } from 'react';
import type { ControlMethod, ControlMethods } from '../../electron/control-types.gen';
import { controlFailureText, type ControlAnswerState } from '../lib/launcher-bridge';

/** A launcher request's result, as `children` shows it; until there is one, what became of
 *  the request. */
export function LauncherAnswer<M extends ControlMethod>({
  state,
  children,
}: {
  state: ControlAnswerState<M>;
  children: (result: ControlMethods[M]['result']) => ReactNode;
}) {
  switch (state.status) {
    case 'loading':
      return <p className="launcher-answer__note">Asking the launcher…</p>;
    case 'unavailable':
      return <p className="launcher-answer__note">The launcher is available in the desktop app only.</p>;
    case 'answered':
      return state.outcome.ok
        ? <>{children(state.outcome.result)}</>
        : <p className="launcher-answer__failure">{controlFailureText(state.outcome.error)}</p>;
  }
}
