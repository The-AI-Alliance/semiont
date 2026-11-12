/**
 * SemiontSession — a state unit: one gateway connection's token and who is
 * signed in. It writes the access token and the user, so it owns and ends
 * them; it uses the SemiontClient it is given, and never ends it. Whoever
 * made the client and the session ends both (`SemiontBrowser` for an
 * application's sessions). One SemiontSession exists per active gateway
 * connection; lifetime is decoupled from React mount lifetime.
 *
 * Headless by design. Runs in browsers, CLIs, workers, and tests.
 * UI-specific state (session-ended/permission-denied modals) lives
 * in `SessionSignals`, which wraps a session — the session
 * itself has no modal observables, no user-facing notifications.
 *
 * Auth is parameterized via callbacks passed at construction:
 *
 *   - `refresh(holding)` — invoked on 401 / proactive re-auth, and given
 *     the token it renews: the one the session holds, or the one it gave up
 *     last when it holds none. Returns the
 *     new access token, or null on failure. The frontend passes a
 *     closure that runs the refresh grant at the issuer; a service
 *     passes one that asks its issuer for a new grant to its account.
 *
 *   - `validate(token)` — optional. If provided, the session asks it
 *     who a token is: at startup, of the stored token, to populate
 *     `user$`; and of a token renewed because the gateway refused the
 *     one before. Frontend passes the gateway's answer; a service may
 *     omit this.
 *
 *   - `onAuthFailed(reason)` — optional. Invoked when the session is
 *     over, with why: `expired`, its issuer refused to renew its token, or
 *     `refused`, the gateway refused a token the issuer had just issued.
 *     UI hosts typically wire this to `SessionSignals.notifySessionEnded`
 *     so a modal surfaces, in the person's language; headless consumers
 *     typically just log.
 *
 * What goes wrong, the session says on `errors$`, its one stream of it: its
 * own errors and its transport's failures, each once. It takes no callback
 * for them.
 *
 * Its sign-in is read, renewed into and forgotten through the `SignInKept`
 * given at construction (`keptIn` for a registry's storage, `MemorySignIn`,
 * an entry of the `SignInStore`): the session never touches `localStorage`
 * or `window` directly, and does not follow what another context writes.
 */

import { BehaviorSubject, type Observable, type Subscription } from 'rxjs';
import { currentUserOf } from '@semiont/http-transport';
import {
  accessToken,
  baseUrl,
  BRIDGED_CHANNELS,
  equalJitter,
  MAX_RECONNECT_MS,
  RECONNECT_MS,
  RETRY_RULES,
  SignInError,
  type AccessToken,
  type BaseUrl,
} from '@semiont/core';
import type { components, StateUnit } from '@semiont/core';
import { SemiontClient, APIError, HttpTransport, HttpContentTransport } from '../client';
import { KeptForFirstReader } from '../kept-for-first-reader';
import type { SemiontError } from '@semiont/core';
import { watched, type Watched } from '@semiont/core';
import type { ConnectionState } from '@semiont/core';
import type { KbTarget } from '@semiont/core';
import {
  isJwtExpired,
  kbGatewayUrl,
  parseJwtExpiry,
  refreshDelayMs,
  type StoredSession,
} from './storage';
import { SemiontSessionError } from './errors';
import type { SemiontSessionErrorCode } from '@semiont/core';
import type { SignInKept } from './sign-in-kept';
import type { SessionStorage } from './session-storage';
import { personKeeping } from '../cache-persister';
import type { SessionEndReason } from './session-signals';
import { SCRIPT_CLIENT_ID, renewKept, signInWithDeviceGrant, type DeviceCode } from './oauth';

export type UserInfo = components['schemas']['UserResponse'];

/** Why a renewal gave no token, for whoever reads the error. */
const notRenewed = (failure: string | undefined): string =>
  failure ? `Token refresh failed: ${failure}` : 'Token refresh failed';

/**
 * Whether a renewal failed because the issuer refused it: an answer
 * `RETRY_RULES.refresh` does not try again. No answer, and one it tries again
 * until the budget is spent, is no refusal.
 */
const refusedByTheIssuer = (failure: unknown): boolean =>
  failure instanceof SignInError
  && failure.code === 'exchange'
  && failure.status !== undefined
  && !RETRY_RULES.refresh.retryable({ status: failure.status });

export interface SemiontSessionConfig {
  kb: KbTarget;
  /** Where the session's sign-in is kept: read at its start, forgotten when it ends. */
  kept: SignInKept;
  /**
   * Pre-built api client. The session does not construct it — caller
   * builds the transport stack and passes the client in. This is the
   * seam where consumers swap one `ITransport` implementation for
   * another (HTTP, in-process, etc.).
   */
  client: SemiontClient;
  /**
   * Token observable shared with the transport. Caller must pass the
   * SAME instance to both the transport (via `HttpTransport` config)
   * and the session. The session writes refreshed tokens here; the
   * transport reads from here.
   */
  token$: BehaviorSubject<AccessToken | null>;
  /**
   * Re-authenticate after expiry / 401. `holding` is the token it renews:
   * the one the session holds, the one the gateway refused or the one due;
   * while it holds none, the one it held last, which is the token found
   * stored at its start though it has expired, or the one a renewal that
   * got no answer was for. Null only when it has held none. Returns a new
   * access token (no "Bearer " prefix) on success, or null if recovery is
   * impossible. Omit for transports where tokens don't apply.
   */
  refresh?: (holding: string | null) => Promise<string | null>;
  /**
   * Validate the stored token at startup and populate `user$`. Omit
   * for service-principal sessions (worker, CLI tools) where there
   * is no user record to fetch.
   */
  validate?: (token: AccessToken) => Promise<UserInfo | null>;
  /**
   * Invoked once when the session ends, with why. Frontend consumers wire
   * this to a UI signal that surfaces the session-ended modal.
   */
  onAuthFailed?: (reason: SessionEndReason) => void;
}

/**
 * A session and the client it was built with, which whoever holds this ends
 * together: what a script's session is (`SemiontSession.fromKept`,
 * `fromHttp`). The session only uses its client, so ending the session alone
 * would leave the client's stream open.
 */
export interface OpenedSession {
  readonly session: SemiontSession;
  /**
   * Close the client, then end the session: what the client's closing flush
   * says reaches the session's errors before they end. Ending twice is
   * ending once.
   */
  dispose(): void;
}

/**
 * Instance counter behind `SemiontSession.id`. Deliberately not a UUID: the
 * id is an in-memory discriminator, never persisted and never sent over the
 * wire, so it needs no entropy — and a counter has no secure-context
 * dependency (`crypto.randomUUID` is undefined over plain HTTP from a
 * non-localhost host).
 */
let sessionSeq = 0;

/**
 * Each session's own voice on its errors stream, set as it is made and read
 * by `sayOn`. Held here rather than on the session, so that what its
 * client's keeping says reaches its errors with no part of its surface.
 */
const voices = new WeakMap<SemiontSession, (error: SemiontSessionError) => void>();

/**
 * Say `error` on `session`'s errors stream, as one of its own: what the
 * keeping of a client a factory built beside it says (`personKeeping`).
 */
export function sayOn(session: SemiontSession, error: SemiontSessionError): void {
  const say = voices.get(session);
  if (say === undefined) throw new Error('A session says what its client keeps only once it is made');
  say(error);
}

export class SemiontSession implements StateUnit {
  /**
   * Identity of THIS LIVE SESSION, distinct from `kb.id` (which knowledge
   * base) — successive sessions for the same KB get different ids.
   *
   * Consumers binding derived state to a session need this: `signIn` on an
   * already-active KB disposes the session and constructs a fresh one under
   * an unchanged `kb.id`, so anything keyed on `kb.id` alone silently keeps
   * pointing at the disposed client and its inert (B16) caches.
   */
  readonly id: string;
  readonly kb: KbTarget;
  readonly client: SemiontClient;
  /** The token the transport sends: the present one, and each after it. Only the session writes it. */
  readonly token$: Watched<AccessToken | null>;
  /** Who is signed in, once the gateway has said. Only the session writes it. */
  readonly user$: Watched<UserInfo | null>;
  readonly streamState$: Observable<ConnectionState>;
  /**
   * The session's one stream of what went wrong, each said once: its own
   * errors (a `SemiontSessionError`: its sign-in could not be checked or
   * renewed, the gateway refused a token just issued, what its client keeps
   * could not be kept, its storage refused a write of it), and its
   * transport's failures, surfaced just before they are thrown to the
   * caller (for `HttpTransport` an `APIError`, status-coded). A registry
   * (`SemiontBrowser`) is the one reader of its sessions' errors, and routes
   * them by `err.code`; headless consumers can subscribe for logging.
   * Of what the session says before anyone reads, its own errors and its
   * transport's failures, the latest `ERRORS_KEPT_FOR_FIRST_READER_COUNT` are
   * kept for the first reader, in the order they were said. It ends when
   * the session does: the client's closing flush, made first, says what it
   * says before then, and what the client meets after is said nowhere. What
   * is still kept then is dropped: a reader that comes after is given nothing.
   */
  readonly errors$: Observable<SemiontError>;

  /** Resolves after the initial validation round-trip completes (success or failure). */
  readonly ready: Promise<void>;

  readonly #heldToken$: BehaviorSubject<AccessToken | null>;
  readonly #heldUser$: BehaviorSubject<UserInfo | null>;
  /** What the session says on `errors$`: its own errors and its transport's failures. */
  readonly #said = new KeptForFirstReader<SemiontError>();
  readonly #transportFailures: Subscription;
  /**
   * The token the session held last, or found stored at its start though it
   * had expired: what a renewal is handed while it holds none. Null while it
   * has held none.
   */
  #heldLast: string | null;
  private readonly kept: SignInKept;
  private readonly doRefresh?: (holding: string | null) => Promise<string | null>;
  private readonly doValidate?: (token: AccessToken) => Promise<UserInfo | null>;
  private readonly onAuthFailed: (reason: SessionEndReason) => void;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** The next renewal owed after one that got no answer, and the step of the wait after it. */
  private unansweredTimer: ReturnType<typeof setTimeout> | null = null;
  private unansweredWaitMs = RECONNECT_MS;
  /** Whether the session is still doing what it does at its start. */
  private starting = true;
  /** The renewal a refusal is being answered with, shared by the refusals that arrive during it. */
  private refusal: Promise<AccessToken | null> | null = null;
  private disposed = false;

  constructor(config: SemiontSessionConfig) {
    // A kept sign-in that cannot be read is its maker's to hear, before
    // anything is begun.
    const stored = config.kept.held();
    this.id = `session-${++sessionSeq}`;
    this.kb = config.kb;
    this.kept = config.kept;
    this.doRefresh = config.refresh;
    this.doValidate = config.validate;
    this.onAuthFailed = config.onAuthFailed ?? (() => {});
    this.client = config.client;
    this.#heldToken$ = config.token$;
    this.token$ = watched(this.#heldToken$);
    this.#heldUser$ = new BehaviorSubject<UserInfo | null>(null);
    this.user$ = watched(this.#heldUser$);
    this.#transportFailures = this.client.transport.errors$.subscribe((failure) => this.#said.say(failure));
    this.errors$ = this.#said.said$;
    voices.set(this, (error) => this.#said.say(error));

    // Reconcile the kept token: if there's a fresh kept access token
    // and `token$` hasn't been seeded yet, push the kept value so the
    // transport (which shares this token$) sees it on first auth.
    if (stored && !isJwtExpired(stored.access) && this.#heldToken$.getValue() === null) {
      this.#heldToken$.next(accessToken(stored.access));
    }
    const initialToken = this.#heldToken$.getValue();
    // An expired token found stored is not sent, but it is the one the
    // start's renewal renews.
    this.#heldLast = initialToken ?? (stored === null ? null : stored.access);

    this.streamState$ = this.client.state$;

    if (initialToken) {
      this.scheduleProactiveRefresh(initialToken);
    }

    this.ready = this.validate(stored).finally(() => {
      this.starting = false;
    });
  }

  /**
   * Run the initial mount-time validation. If a stored access token is
   * present and unexpired, call the configured `validate` with it to
   * confirm it still works and populate `user$`. If expired, try
   * refresh first: the issuer's refusal forgets the saved sign-in, with what
   * was kept for its person, and a
   * renewal that got no answer keeps it, says why as `session.auth-failed`,
   * and leaves it to be renewed when a request is refused. When validate's
   * token is refused (a 401, or a 429
   * `refusal-rate`), try refresh once, and ask once more; a second refusal
   * ends the session. Surfaces auth-failed when the gateway could not be
   * asked.
   *
   * When no `validate` callback is provided (service principals), this
   * still runs through the refresh-if-expired step so the stored
   * token is current — it just skips the user-validation round trip.
   */
  private async validate(stored: StoredSession | null): Promise<void> {
    if (!stored) return;

    const expired = isJwtExpired(stored.access);
    let startToken = stored.access;
    if (expired) {
      const { token, failure, refused } = await this.tryRefresh();
      if (!token) {
        if (failure === undefined || refused) {
          // There was no session to end: the kept sign-in is forgotten, with what was kept for its person, and nothing is said.
          this.kept.forget();
        } else {
          // The issuer did not refuse it: the stored session is kept, and renewed on the reconnect backoff or when a request is refused.
          this.renewAgainLater();
          this.#said.say(new SemiontSessionError('session.auth-failed', notRenewed(failure), this.kb.id));
        }
        return;
      }
      startToken = token;
    }

    if (startToken !== stored.access) {
      this.hold(startToken);
      this.scheduleProactiveRefresh(startToken);
    }

    // No validate callback => service-principal session. Token is
    // current; `user$` stays null. Done.
    if (!this.doValidate) return;

    // The gateway is asked who the token is. A token it refuses is renewed
    // once and asked about once more. A token the issuer has JUST issued and
    // the gateway refuses is final: renewing again cannot change the answer.
    // Asking again for as long as the issuer goes on issuing is a loop with
    // no end — one browser tab can send a gateway 300 requests a second. So
    // the gateway is asked at most twice and the issuer at most once
    // (protocol/specs/src/session/cases.json, `startup`).
    const validate = this.doValidate;
    let token = startToken;
    let justIssued = expired;
    for (;;) {
      if (this.disposed) return;
      try {
        const data = await validate(accessToken(token));
        if (this.disposed) return;
        this.#heldUser$.next(data);
        return;
      } catch (err) {
        if (this.disposed) return;
        if (!(err instanceof APIError && err.code === 'unauthorized')) {
          this.#said.say(
            new SemiontSessionError(
              'session.auth-failed',
              err instanceof Error ? err.message : String(err),
              this.kb.id,
            ),
          );
          return;
        }
        if (justIssued) {
          this.signedOut('refused', 'session.credential-refused', 'The gateway refused a token its issuer had just issued');
          return;
        }
        // The session's token has changed since the ask: the stream
        // was refused with it too, and `refresh` has renewed it meanwhile.
        // That token is the just-issued one, and is not renewed again.
        const current = this.#heldToken$.getValue();
        if (current !== token) {
          if (current === null) return;
          token = current;
          justIssued = true;
          continue;
        }
        const { token: renewed, failure, refused } = await this.tryRefresh();
        if (this.disposed) return;
        if (!renewed) {
          this.unrenewed(failure, refused);
          return;
        }
        this.hold(renewed);
        this.scheduleProactiveRefresh(renewed);
        token = renewed;
        justIssued = true;
      }
    }
  }

  /**
   * The session is over: its kept sign-in is forgotten, with what was kept
   * for the person it named, and the person and the application are each
   * told why. The one teardown, whichever way the session ended.
   */
  private signedOut(told: SessionEndReason, code: SemiontSessionErrorCode, why: string): void {
    this.clearRefreshTimer();
    this.clearUnanswered();
    this.#heldToken$.next(null);
    this.kept.forget();
    this.onAuthFailed(told);
    this.#said.say(new SemiontSessionError(code, why, this.kb.id));
  }

  /** Hold `token`: the transport sends it from now on, and a renewal is handed it. */
  private hold(token: string): AccessToken {
    const held = accessToken(token);
    this.#heldLast = token;
    this.#heldToken$.next(held);
    return held;
  }

  /**
   * Call the configured refresh callback with the token it renews, the one
   * the session holds or, holding none, the one it held last, converting a
   * THROW into a "no token" answer that says why.
   *
   * The callback makes an HTTP call, so it can reject as easily as it can
   * resolve null — a network blip, DNS failure, or gateway 5xx. A throw that
   * escaped the renewal would skip every terminal behaviour; through the
   * proactive timer's un-awaited call it would become an unhandled
   * rejection with NO further refresh scheduled, leaving a session holding
   * an expired token forever.
   *
   * The reason is returned rather than swallowed, and whether it is the
   * issuer's refusal: a network failure and a revoked session are not the
   * same event. Only the refusal ends the session and forgets what is
   * stored, and an operator reading the error needs to know which one
   * happened.
   */
  private async tryRefresh(): Promise<{ token: string | null; failure?: string; refused: boolean }> {
    if (!this.doRefresh) return { token: null, refused: false };
    try {
      return { token: await this.doRefresh(this.#heldToken$.getValue() ?? this.#heldLast), refused: false };
    } catch (err) {
      return { token: null, failure: err instanceof Error ? err.message : String(err), refused: refusedByTheIssuer(err) };
    }
  }

  /**
   * The gateway refused `refused`, the token a request carried (null when it
   * carried none): renew it, and ask the gateway who the new one is. This is
   * what the session's transport calls when it is refused a token. A token
   * the session no longer holds was answered already, renewed or ended: what
   * the session holds is given, and nothing is renewed or asked, however late
   * the refusal arrives.
   *
   * The rule is startup's (protocol/specs/src/session/cases.json, `refusal`): a token
   * the issuer has just issued and the gateway refuses is final, and the
   * session ends as `session.credential-refused`. So one refusal costs at
   * most one renewal and one ask, and a gateway that refuses whatever its
   * issuer issues is not asked again for every request that follows. A
   * gateway that cannot be asked refuses nothing: the renewed token is
   * given. A session of a service, which has nobody to ask about, only
   * renews.
   *
   * Refusals that arrive together are answered together: one renewal and
   * one ask, however many requests were refused at once. Who the gateway
   * says the renewed token is, is who is signed in.
   */
  async refresh(refused: string | null): Promise<AccessToken | null> {
    // A refusal that arrives while another is answered waits for that answer.
    if (this.refusal) await this.refusal;
    const held = this.#heldToken$.getValue();
    if (held !== refused) return this.disposed ? null : held;
    this.refusal ??= this.renewForRefusal().finally(() => {
      this.refusal = null;
    });
    return this.refusal;
  }

  private async renewForRefusal(): Promise<AccessToken | null> {
    const renewed = await this.renew();
    const validate = this.doValidate;
    // While the session is starting, its start is what asks: it finds the
    // token renewed here and takes it up as the just-issued one. Asking here
    // too would be a second ask about one renewal.
    if (!renewed || !validate || this.starting) return renewed;
    try {
      const user = await validate(renewed);
      // Who the token the session still holds is, as the gateway said.
      if (!this.disposed && this.#heldToken$.getValue() === renewed) this.#heldUser$.next(user);
    } catch (err) {
      if (this.disposed) return null;
      const refused = err instanceof APIError && err.code === 'unauthorized';
      // Only a token the session still holds ends it: one replaced while
      // the gateway was being asked (another context signed in, or renewed)
      // is not the session's to be refused.
      if (refused && this.#heldToken$.getValue() === renewed) {
        this.signedOut('refused', 'session.credential-refused', 'The gateway refused a token its issuer had just issued');
      }
    }
    return this.disposed ? null : this.#heldToken$.getValue();
  }

  /**
   * Renew the token at the issuer, with nobody asked afterwards: what the
   * session does on its own schedule, where no refusal came first.
   */
  private async renew(): Promise<AccessToken | null> {
    if (this.disposed) return null;
    if (!this.doRefresh) return null;
    const { token: newAccess, failure, refused } = await this.tryRefresh();
    if (this.disposed) return null;
    if (newAccess) {
      this.clearUnanswered();
      const tok = this.hold(newAccess);
      this.scheduleProactiveRefresh(newAccess);
      return tok;
    }
    // You cannot expire a session that never existed. With no kept
    // sign-in there is nothing to refresh AND nothing to tear down —
    // a 401 here just means "signed out", which the shell already renders.
    // Declaring expiry anyway is a modal loop: `activeKnowledgeBaseId`
    // persists forever, every load activates the KB credential-less, the
    // actor's null-token connect 401s, and the "expired" modal re-arms on
    // a session that never signed in.
    // (This also makes the REAL teardown below fire once: it forgets the
    // kept sign-in, so any follow-up 401s take this quiet path.)
    let nothingKept: boolean;
    try {
      nothingKept = this.kept.held() === null;
    } catch (cause) {
      // A sign-in that cannot be read is a renewal with no answer: what is
      // stored stays, and is renewed again on the backoff.
      this.unrenewed(failure ?? (cause instanceof Error ? cause.message : String(cause)), false);
      return null;
    }
    if (nothingKept) {
      this.clearUnanswered();
      this.#heldToken$.next(null);
      return null;
    }
    this.unrenewed(failure, refused);
    return null;
  }

  /**
   * A renewal of what is stored gave no token, and the session holds none.
   * The issuer's refusal, or nothing left to renew with, ends the session; any
   * other failure keeps what is stored, and says why: the next refusal renews
   * again, and so does the reconnect backoff.
   */
  private unrenewed(failure: string | undefined, refused: boolean): void {
    if (failure === undefined || refused) {
      this.signedOut('expired', 'session.refresh-exhausted', notRenewed(failure));
      return;
    }
    this.clearRefreshTimer();
    this.#heldToken$.next(null);
    this.renewAgainLater();
    this.#said.say(new SemiontSessionError('session.refresh-exhausted', notRenewed(failure), this.kb.id));
  }

  /**
   * After a renewal that got no answer, renew again on the reconnect backoff:
   * each wait is the equal jitter of its step, the step `RECONNECT_MS`
   * doubling to `MAX_RECONNECT_MS`. It ends when a renewal is made or refused,
   * when a token arrives some other way, and when the session ends. A renewal
   * already owed is not owed twice. A renewal made while nobody has said who
   * the session's token is asks the gateway once, as the start would have.
   */
  private renewAgainLater(): void {
    if (this.disposed || this.unansweredTimer) return;
    const step = this.unansweredWaitMs;
    this.unansweredWaitMs = Math.min(2 * step, MAX_RECONNECT_MS);
    this.unansweredTimer = setTimeout(() => {
      this.unansweredTimer = null;
      if (this.disposed) return;
      if (this.#heldToken$.getValue() !== null) {
        this.unansweredWaitMs = RECONNECT_MS;
        return;
      }
      void (this.#heldUser$.getValue() === null ? this.refresh(null) : this.renew());
    }, equalJitter(step));
  }

  private clearUnanswered(): void {
    if (this.unansweredTimer) {
      clearTimeout(this.unansweredTimer);
      this.unansweredTimer = null;
    }
    this.unansweredWaitMs = RECONNECT_MS;
  }

  private scheduleProactiveRefresh(token: string): void {
    this.clearRefreshTimer();
    // The delay is derived from the token's own lifetime, never from a fixed
    // margin: a fixed margin can equal the lifetime an issuer mints
    // (Keycloak's default is five minutes), which gives a delay of zero that
    // reschedules itself on arrival. See `refreshDelayMs`.
    const delay = refreshDelayMs(token);
    if (delay === null) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      if (!this.disposed) void this.renew();
    }, delay);
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  get expiresAt(): Date | null {
    const token = this.#heldToken$.getValue();
    return token ? parseJwtExpiry(token) : null;
  }

  /**
   * End the session: its renewal stops, and its token, its user and its
   * errors complete. The client is left to whoever made it, who closes it
   * first, so that what its closing flush says is said on `errors$` before
   * they end.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.clearRefreshTimer();
    this.clearUnanswered();
    this.#transportFailures.unsubscribe();

    this.#heldToken$.complete();
    this.#heldUser$.complete();
    this.#said.end();
  }

  /**
   * Convenience factory for the default HTTP setup. Constructs the
   * shared `BehaviorSubject<AccessToken | null>`, an `HttpTransport`,
   * an `HttpContentTransport`, and a `SemiontClient`, then wires
   * the session over them. Removes the load-bearing
   * "same-token$-instance" invariant from the caller's hands. Gives the
   * session with the client it built, for the caller to end together.
   *
   * Strings are accepted for `baseUrl` and `token`; they are branded
   * via `baseUrl()` / `accessToken()` from `@semiont/core` automatically.
   *
   * The remaining options (`refresh`, `validate`, `onAuthFailed`) match
   * `SemiontSessionConfig` exactly. `fetch` is what every
   * request of the transport is sent with; absent, the runtime's own.
   */
  static fromHttp(opts: {
    kb: KbTarget;
    kept: SignInKept;
    baseUrl: BaseUrl | string;
    token?: AccessToken | string | null;
    fetch?: typeof fetch;
    refresh?: (holding: string | null) => Promise<string | null>;
    validate?: (token: AccessToken) => Promise<UserInfo | null>;
    onAuthFailed?: (reason: SessionEndReason) => void;
  }): OpenedSession {
    return SemiontSession.overHttp(opts, undefined);
  }

  /**
   * The session `fromHttp` builds, its client keeping in `storage` what a
   * registry's does (B17) for the person the kept sign-in names, or nothing
   * when it is given none: from the start, or once `validate` says who the
   * token is, with the stream's places coupled to the client. What that
   * keeping says, the session says on its errors.
   */
  private static overHttp(opts: Parameters<typeof SemiontSession.fromHttp>[0], storage: SessionStorage | undefined): OpenedSession {
    let session!: SemiontSession;
    const keeps = storage === undefined
      ? null
      : personKeeping(storage, opts.kb.id, opts.kept, (error) => session.#said.say(error));
    const url = typeof opts.baseUrl === 'string' ? baseUrl(opts.baseUrl) : opts.baseUrl;
    const tok = opts.token == null
      ? null
      : (typeof opts.token === 'string' ? accessToken(opts.token) : opts.token);
    const token$ = new BehaviorSubject<AccessToken | null>(tok);
    // A session may be handed a token that the gateway no longer accepts
    // (for example after its issuer rotates signing keys). Let the transport
    // renew it on a 401, just as createHttpSessionFactory does; otherwise a
    // bus request waits on a stream that keeps retrying the refused token
    // until its own deadline expires.
    const transport = new HttpTransport({
      baseUrl: url,
      token$,
      channels: BRIDGED_CHANNELS,
      tokenRefresher: (refused) => session.refresh(refused),
      ...(keeps === null ? {} : { saveLastEventId: keeps.saveLastEventId }),
      ...(keeps === null || keeps.fromStart === null ? {} : { loadLastEventIds: keeps.fromStart.places.loadLastEventIds }),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    const content = new HttpContentTransport(transport);
    const fromStart = keeps === null ? null : keeps.fromStart;
    const client = new SemiontClient(transport, content, transport, fromStart === null ? {} : { cachePersistence: fromStart.persistence });
    if (fromStart !== null) fromStart.places.coupleTo(client);
    const config: SemiontSessionConfig = { kb: opts.kb, kept: opts.kept, client, token$ };
    if (opts.refresh) config.refresh = opts.refresh;
    if (opts.validate) {
      const validate = opts.validate;
      // Who the token is, as validate says, starts keeping for that person
      // before the answer is handed back, so before the session is ready.
      config.validate = keeps === null ? validate : async (token) => {
        const user = await validate(token);
        if (user !== null) keeps.named(token, user.did, client, transport);
        return user;
      };
    }
    if (opts.onAuthFailed) config.onAuthFailed = opts.onAuthFailed;
    try {
      session = new SemiontSession(config);
    } catch (error) {
      // A kept sign-in that cannot be read makes no session: the client made for it is closed.
      client.dispose();
      throw error;
    }
    return {
      session,
      dispose: () => {
        client.dispose();
        session.dispose();
      },
    };
  }

  /**
   * A session with the knowledge base `kb`, at the gateway its endpoint
   * names, over the sign-in `kept` holds: the sign-in `semiont login` keeps,
   * when `kept` is an entry of a `SignInStore`; a script's device grant, kept
   * by `signInDevice`; a test harness's minted pair, in a `MemorySignIn`. It
   * starts with the kept access token, renewed first when it has expired, and
   * each renewal is kept where the sign-in is; a renewal the issuer refuses
   * forgets it there. With nothing kept, the session is signed out: its
   * token is null, and a request made through its client is refused. It
   * asks the gateway who its token is, and so learns who is signed in,
   * unless `validate` is false; left out, it is true. The
   * session's `ready` has resolved when this returns. Gives it with the
   * client it was built with, as `fromHttp` does. The gateway and the issuer
   * are asked with `fetch`, or the runtime's own. Throws a
   * `SemiontSessionError` (`session.construct-failed`), before anything is
   * asked, for a knowledge base that is not reached over HTTP, and what
   * reading the kept sign-in threw, when it cannot be read.
   *
   * Given a `storage`, the client keeps there what a registry's does (B17)
   * for the person the kept sign-in names, while it names them: the persisted
   * queries' values, and the stream's places, coupled to the client. A
   * sign-in that names nobody yet keeps nothing until the gateway says who
   * its token is: the person's key is then recorded on the kept sign-in, and
   * the client keeps for them from then on. Told not to ask, the session
   * keeps only for a person the sign-in already names. A sign-in that cannot
   * be read before a save, or cannot record the person the gateway named, is
   * said on the session's `errors$` as `session.keep-failed`, once, and the
   * client keeps nothing more; each write the storage refuses is said there
   * as `session.save-refused`.
   */
  static async fromKept(opts: {
    kb: KbTarget;
    kept: SignInKept;
    storage?: SessionStorage;
    fetch?: typeof fetch;
    /** Whether the session asks the gateway who its token is. True when left out. */
    validate?: boolean;
    onAuthFailed?: (reason: SessionEndReason) => void;
  }): Promise<OpenedSession> {
    if (opts.kb.endpoint.kind !== 'http') {
      throw new SemiontSessionError(
        'session.construct-failed',
        `A session over a kept sign-in needs an HTTP endpoint; this knowledge base's is "${opts.kb.endpoint.kind}"`,
        opts.kb.id,
      );
    }
    const gateway = kbGatewayUrl(opts.kb.endpoint);
    // A session over a kept sign-in learns whose caches to keep by asking.
    const asks = opts.validate ?? true;
    // One renewal at a time. A stream refused and a request refused at the
    // same moment each ask for one, and an issuer that rotates refresh tokens
    // refuses the second grant, which would end a session that was fine.
    let renewing: Promise<string | null> | null = null;
    const opened = SemiontSession.overHttp({
      kb: opts.kb,
      kept: opts.kept,
      baseUrl: gateway,
      refresh: (holding) => {
        renewing ??= renewKept(opts.kept, holding, opts.fetch).finally(() => { renewing = null; });
        return renewing;
      },
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(asks ? { validate: (token: AccessToken) => currentUserOf(baseUrl(gateway), token, opts.fetch) } : {}),
      ...(opts.onAuthFailed ? { onAuthFailed: opts.onAuthFailed } : {}),
    }, opts.storage);
    await opened.session.ready;
    return opened;
  }

  /**
   * The device authorization grant (RFC 8628): a script signs in as a
   * person, and the sign-in is kept in `kept`. The issuer the knowledge base
   * trusts mints a code, `onCode` shows the person where to approve it, and
   * the tokens come back here — no password ever passes through the process.
   * A script then builds its session over `kept` with `fromKept`. Throws a
   * `SignInError` when the KB trusts no issuer, the person denies, or the
   * code expires. The knowledge base and its issuer are asked with `fetch`,
   * or the runtime's own.
   */
  static async signInDevice(opts: {
    kb: KbTarget;
    kept: SignInKept;
    onCode: (code: DeviceCode) => void;
    signal?: AbortSignal;
    fetch?: typeof fetch;
  }): Promise<void> {
    if (opts.kb.endpoint.kind !== 'http') {
      throw new Error(`The device grant needs an HTTP endpoint; this knowledge base's is "${opts.kb.endpoint.kind}"`);
    }
    const { issuer, tokens } = await signInWithDeviceGrant({
      target: opts.kb.endpoint,
      onCode: opts.onCode,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    opts.kept.keep({
      access: tokens.access,
      refresh: tokens.refresh,
      clientId: SCRIPT_CLIENT_ID,
      tokenEndpoint: issuer.token,
      ...(issuer.revocation ? { revocationEndpoint: issuer.revocation } : {}),
    });
  }
}
