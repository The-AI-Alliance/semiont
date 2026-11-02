import type { KbCoordinates } from './user-config';

/** What resuming a knowledge base's stored session found. */
export type Resumed =
  | { kind: 'resumed'; access: string }
  /** Nothing is stored for this knowledge base. */
  | { kind: 'none' }
  /** A session is stored and its issuer refused to renew it (revoked, expired, or already
   *  rotated): the person signs in again. `reason` is the issuer's own answer. */
  | { kind: 'refused'; reason: string };

/**
 * What the desktop shell does at a knowledge base's issuer on the renderer's behalf
 * (`window.authBridge`; the preload exposes it, `electron/auth.ts` answers it).
 *
 * It exists because an issuer answers only the origins its client registration lists, and
 * a page chat serves is not one of them: every request to the issuer is made by Electron's
 * main process, which sends no `Origin`. The tokens stay there too. The renderer is handed
 * an access token and asks for the next one.
 *
 * `kbId` names the stored session: a `KbTarget`'s `id`.
 */
export interface AuthBridge {
  /** The session stored for this knowledge base, renewed if it was about to expire: its
   *  access token, or that nothing is stored, or that its issuer refused it. Rejects, with
   *  the cause, when the stored session cannot be read or the issuer cannot be reached.
   *  Never opens a browser. */
  resume(kbId: string): Promise<Resumed>;
  /** Sign a person in at the issuer the knowledge base trusts, in their own browser, and
   *  store the session. Resolves to its access token; rejects when the sign-in is refused,
   *  abandoned, or the knowledge base cannot be reached. */
  signIn(kbId: string, address: KbCoordinates): Promise<string>;
  /** Renew the stored session. Null when nothing is stored; rejects when the issuer
   *  refuses the renewal or cannot be reached. */
  refresh(kbId: string): Promise<string | null>;
  /** Revoke the stored session at its issuer and forget it. */
  signOut(kbId: string): Promise<void>;
}
