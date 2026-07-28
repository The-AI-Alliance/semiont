import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckIcon, PlusIcon, ArrowRightStartOnRectangleIcon, XMarkIcon, TrashIcon } from '@heroicons/react/24/outline';
import { BehaviorSubject } from 'rxjs';
import { SemiontClient, defaultProtocol, isValidHostname, type KnowledgeBase, type KbSessionStatus } from '@semiont/sdk';
import { HttpContentTransport, HttpTransport } from '@semiont/http-transport';
import { accessToken, baseUrl, type AccessToken } from '@semiont/core';
import type { DiscoveredKB } from '@semiont/core';
import {
  useSemiont,
  useObservable,
  useKBDiscovery,
} from '@semiont/react-ui';

type T = (key: string, params?: Record<string, unknown>) => string;

const STATUS_COLORS: Record<KbSessionStatus, string> = {
  authenticated: 'var(--semiont-color-success-500, #22c55e)',
  expired: 'var(--semiont-color-warning-500, #eab308)',
  'signed-out': 'var(--semiont-color-neutral-400, #9ca3af)',
  unreachable: 'var(--semiont-color-error-500, #ef4444)',
};

const STATUS_KEYS: Record<KbSessionStatus, string> = {
  authenticated: 'statusConnected',
  expired: 'statusExpired',
  'signed-out': 'statusSignedOut',
  unreachable: 'statusUnreachable',
};

const endpointKey = (host: string, port: number) => `${host}:${port}`;

/**
 * Fixed-shape rendering: a field that should be present but isn't renders
 * this placeholder — a visible gap, never a semantic fallback to some other
 * field.
 */
const MISSING = '–';

/** Placement badge — also the managed marker on an adopted registered row. */
function PlacementBadge({ placement, t }: { placement: DiscoveredKB['placement']; t: T }) {
  return (
    <span
      title={t('managedBadge')}
      style={{
        fontSize: '0.65rem',
        padding: '0 0.375rem',
        borderRadius: '9999px',
        border: '1px solid var(--semiont-color-primary-500, #3b82f6)',
        color: 'var(--semiont-color-primary-500, #3b82f6)',
        flexShrink: 0,
      }}
    >
      {t(placement === 'local' ? 'placementLocal' : 'placementCodespace')}
    </span>
  );
}

function StatusDot({ status, t }: { status: KbSessionStatus; t: T }) {
  return (
    <span
      title={t(STATUS_KEYS[status])}
      style={{
        width: '0.5rem',
        height: '0.5rem',
        borderRadius: '50%',
        backgroundColor: STATUS_COLORS[status],
        flexShrink: 0,
      }}
    />
  );
}

function LoginForm({ t, title, onSubmit, onCancel, error, isSubmitting, autoFocus, pulsing, initialHost = 'localhost', initialPort = 4000, initialEmail = 'admin@example.com' }: {
  t: T;
  /** Overrides the generic heading — used to announce a contested ADDRESS (D). */
  title?: string;
  onSubmit: (host: string, port: number, protocol: 'http' | 'https', email: string, password: string) => Promise<void>;
  onCancel: () => void;
  error: string | null;
  isSubmitting: boolean;
  autoFocus?: boolean;
  pulsing?: boolean;
  initialHost?: string;
  initialPort?: number;
  initialEmail?: string;
}) {
  const [host, setHost] = useState(initialHost);
  const [port, setPort] = useState(String(initialPort));
  const [protocol, setProtocol] = useState<'http' | 'https'>(defaultProtocol(initialHost));
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');

  const handleHostChange = (newHost: string) => {
    setHost(newHost);
    setProtocol(defaultProtocol(newHost));
  };

  return (
    <div
      className={pulsing ? 'semiont-panel__login-form--pulsing' : ''}
      style={{
        margin: '0.5rem',
        padding: '0.75rem',
        border: '1px solid var(--semiont-color-neutral-200, #e5e7eb)',
        borderRadius: 'var(--semiont-panel-border-radius, 0.5rem)',
        background: 'var(--semiont-bg-secondary, transparent)',
      }}
    >
      <h3 style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.5rem' }}>{title ?? t('connectTitle')}</h3>
      <form onSubmit={(e) => { e.preventDefault(); if (isValidHostname(host)) onSubmit(host, parseInt(port, 10) || 4000, protocol, email, password); }} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <select value={protocol} onChange={e => setProtocol(e.target.value as 'http' | 'https')} className="semiont-input">
          <option value="http">HTTP</option>
          <option value="https">HTTPS</option>
        </select>
        <input type="text" value={host} onChange={e => handleHostChange(e.target.value)} placeholder="Host" className="semiont-input" autoFocus={autoFocus} />
        <input type="number" value={port} onChange={e => setPort(e.target.value)} placeholder="Port" className="semiont-input" />
        {host && !isValidHostname(host) && (
          <div style={{ color: 'var(--semiont-color-error-500, #ef4444)', fontSize: '0.75rem' }}>{t('invalidHost')}</div>
        )}
        <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" className="semiont-input" />
        <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" className="semiont-input" />
        {error && <div style={{ color: 'var(--semiont-color-error-500, #ef4444)', fontSize: '0.75rem' }}>{error}</div>}
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button type="submit" className="semiont-button semiont-button--primary" style={{ flex: 1 }} disabled={isSubmitting || !isValidHostname(host)}>
            {isSubmitting ? t('connecting') : t('connect')}
          </button>
          <button type="button" className="semiont-button" onClick={onCancel}>
            <XMarkIcon style={{ width: '1rem', height: '1rem' }} />
          </button>
        </div>
      </form>
    </div>
  );
}

function ReauthForm({ t, kb, onSubmit, onCancel, error, isSubmitting }: {
  t: T;
  kb: KnowledgeBase;
  onSubmit: (password: string) => Promise<void>;
  onCancel: () => void;
  error: string | null;
  isSubmitting: boolean;
}) {
  const [password, setPassword] = useState('');

  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(password); }} style={{ padding: '0.5rem 0.75rem', display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
      <div style={{ fontSize: '0.75rem', color: 'var(--semiont-color-neutral-400)' }}>{kb.email}</div>
      <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" className="semiont-input" style={{ fontSize: '0.8rem' }} autoFocus />
      {error && <div style={{ color: 'var(--semiont-color-error-500, #ef4444)', fontSize: '0.75rem' }}>{error}</div>}
      <div style={{ display: 'flex', gap: '0.375rem' }}>
        <button type="submit" className="semiont-button semiont-button--primary" style={{ flex: 1, fontSize: '0.8rem' }} disabled={isSubmitting}>
          {isSubmitting ? t('signingIn') : t('signIn')}
        </button>
        <button type="button" className="semiont-button" onClick={onCancel} style={{ fontSize: '0.8rem' }}>
          {t('cancel')}
        </button>
      </div>
    </form>
  );
}

/**
 * Thrown when authentication succeeds but the KB's identity cannot be
 * established. A registered KB REQUIRES a did (KB-IDENTITY-VS-ADDRESS
 * decision 8), and there is nothing legitimate to fall back to: inventing one
 * from the address is the exact category error that document exists to end.
 * Decision 7's third verification outcome, made explicit.
 *
 * The two reasons are kept apart deliberately: collapsing them into one
 * message made a live auth bug undiagnosable from the UI (2026-07-28).
 */
class IdentityUnverifiableError extends Error {
  constructor(readonly reason: 'unreachable' | 'not-reported', detail: string) {
    super(detail);
  }
}

async function authenticateWithBackend(host: string, port: number, protocol: 'http' | 'https', emailStr: string, password: string): Promise<{ token: string; refreshToken: string; did: string; label: string; gitBranch?: string }> {
  const origin = `${protocol}://${host}:${port}`;
  // `/api/status` REQUIRES authentication, so the transport needs a token
  // source: without one the identity check goes out unauthenticated and 401s
  // on every connect (found live 2026-07-28 — previously swallowed, which is
  // why labels silently fell back to `host:port`). Same pattern the session
  // factory's `performValidate` uses.
  const token$ = new BehaviorSubject<AccessToken | null>(null);
  const transport = new HttpTransport({ baseUrl: baseUrl(origin), token$ });
  const client = new SemiontClient(transport, new HttpContentTransport(transport), transport);

  // The cleanup wraps EVERY exit, not just the status call. The transport
  // subscribes to token$ the moment it is constructed, so a throw before the
  // status check — a rejected password, a response missing either token —
  // leaked it. Scoping the finally to the narrow try covered the one failure
  // that happened to be on screen and none of the earlier ones.
  try {
    const authResult = await client.auth!.password(emailStr, password);
    const token = authResult.token;
    const refreshToken = authResult.refreshToken;
    if (!token) throw new Error('No access token received');
    if (!refreshToken) throw new Error('No refresh token received');
    // Every later call on this client is now authenticated.
    token$.next(accessToken(token));

    // The KB names itself: identity is read from the KB we actually reached,
    // never inferred from the discovered row the user happened to click.
    let status;
    try {
      status = await client.admin!.status();
    } catch (e) {
      throw new IdentityUnverifiableError('unreachable', e instanceof Error ? e.message : String(e));
    }
    if (!status.did) throw new IdentityUnverifiableError('not-reported', 'status reported no did');

    return {
      token,
      refreshToken,
      did: status.did,
      // Absence is stored as absence — the WORD "Unknown" is a render concern
      // (decision 7), and `host:port` is an address, never a name.
      label: status.projectName ?? '',
      ...(status.gitBranch ? { gitBranch: status.gitBranch } : {}),
    };
  } finally {
    transport.dispose();
    token$.complete();
  }
}

export function KnowledgeBasePanel() {
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`KnowledgeBasePanel.${k}`, p as any) as string;
  const semiont = useSemiont();
  const knowledgeBases = useObservable(semiont.kbs$) ?? [];
  const activeKnowledgeBase = useObservable(semiont.activeSession$)?.kb ?? null;
  const setActiveKnowledgeBase = (id: string) => { void semiont.setActiveKb(id); };
  const addKnowledgeBase = semiont.addKb.bind(semiont);
  const removeKnowledgeBase = semiont.removeKb.bind(semiont);
  const updateKnowledgeBase = semiont.updateKb.bind(semiont);
  const signIn = (id: string, access: string, refresh: string) => { void semiont.signIn(id, access, refresh); };
  const signOut = (id: string) => { void semiont.signOut(id); };
  // null = closed; {} = blank form; {host, port} = prefilled from a discovered
  // row. `expected*` records WHAT THE USER BELIEVED they were connecting to, so
  // the outcome can be verified against the KB that actually answers (C).
  const [addForm, setAddForm] = useState<
    { host?: string; port?: number; expectedDid?: string; expectedName?: string } | null
  >(null);
  // Transient result of that verification — the form has closed by then.
  const [connectNotice, setConnectNotice] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [addSubmitting, setAddSubmitting] = useState(false);
  const [reauthKbId, setReauthKbId] = useState<string | null>(null);
  const [reauthError, setReauthError] = useState<string | null>(null);
  const [reauthSubmitting, setReauthSubmitting] = useState(false);
  const [confirmRemoveKbId, setConfirmRemoveKbId] = useState<string | null>(null);
  const [, setTick] = useState(0);

  // Launcher discovery (BROWSER-KB-DISCOVERY P5). The document is launcher
  // BELIEF — health stays this panel's own probe. Collision policy: a
  // discovered KB matching a registered endpoint is ADOPTED render-only (one
  // row, managed badge, registry untouched — fully reversible); removal is
  // projection-only (discovered rows vanish, adopted rows lose the badge).
  const { kbs: discoveredKbs } = useKBDiscovery();
  // The join (KB-IDENTITY-VS-ADDRESS decision 9): **look up by address, verify
  // by did.** The address is what is unique within a document (P1), so it
  // SELECTS; the did then confirms the copy we reached is the KB we meant. A
  // did can match several entries — one KB running in two places is normal and
  // expected — so it can never be the selector. Grouping survives from P0
  // because an older document can still contain duplicate addresses.
  const discoveredByEndpoint = new Map<string, DiscoveredKB[]>();
  for (const d of discoveredKbs) {
    const key = endpointKey(d.host, d.port);
    const bucket = discoveredByEndpoint.get(key);
    if (bucket) bucket.push(d);
    else discoveredByEndpoint.set(key, [d]);
  }
  const unambiguousAt = (key: string): DiscoveredKB | undefined => {
    const bucket = discoveredByEndpoint.get(key);
    return bucket?.length === 1 ? bucket[0] : undefined;
  };
  const managedFor = (kb: KnowledgeBase): DiscoveredKB | undefined => {
    if (kb.endpoint.kind !== 'http') return undefined;
    const entry = unambiguousAt(endpointKey(kb.endpoint.host, kb.endpoint.port));
    // Verification: an entry at my address that is a DIFFERENT knowledge base
    // is not mine to adopt — it is someone else standing where I connected.
    // (A registered KB whose address matches nothing is simply unmanaged; the
    // spelling-mismatch miss is accepted deliberately — see the plan.)
    return entry && entry.did === kb.did ? entry : undefined;
  };
  // Only an ADOPTED endpoint drops out of the discovered list; ambiguous ones
  // keep every claimant visible so the stale record is surfaced, not swallowed.
  const adoptedEndpoints = new Set(
    knowledgeBases.flatMap(kb =>
      kb.endpoint.kind === 'http' && managedFor(kb)
        ? [endpointKey(kb.endpoint.host, kb.endpoint.port)]
        : []),
  );
  const unregisteredDiscovered = discoveredKbs.filter(d => !adoptedEndpoints.has(endpointKey(d.host, d.port)));
  // One KB in two places is normal (decision 9), so a discovered row can carry
  // the same name as a KB you are already connected to. Say why, rather than
  // leaving it looking like a duplicate — the identity is what relates them.
  const registeredDids = new Set(knowledgeBases.map(kb => kb.did));
  const isAnotherCopy = (d: DiscoveredKB): boolean => registeredDids.has(d.did);
  // A duplicated ADDRESS is a conflict: only one process binds a port, so at
  // most one claimant's promise is true (decision 4, narrowed by 9 — a shared
  // DID is not a conflict). Producers no longer emit these; old documents can.
  const conflictedAddresses = [...discoveredByEndpoint.entries()]
    .filter(([, bucket]) => bucket.length > 1)
    .map(([address, bucket]) => ({ address, count: bucket.length }));
  // (D) A click was always an address; when the address is contested, the form
  // says so instead of carrying a KB name that is at most half true.
  const addFormAddress = addForm?.host !== undefined && addForm.port !== undefined
    ? endpointKey(addForm.host, addForm.port)
    : null;
  const addFormContested = addFormAddress !== null
    && (discoveredByEndpoint.get(addFormAddress)?.length ?? 0) > 1;

  useEffect(() => {
    if (knowledgeBases.length === 0) setAddForm({});
  }, [knowledgeBases.length]);

  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 30_000);
    return () => clearInterval(interval);
  }, []);

  const openAddForm = (prefill: { host?: string; port?: number; expectedDid?: string; expectedName?: string } = {}) => {
    setAddForm(prefill);
    setReauthKbId(null);
    setAddError(null);
    setConnectNotice(null);
  };

  // An unreachable identity check and a KB that reports no identity are
  // different problems with different fixes; one message for both hid a live
  // auth bug for a whole release.
  const identityAwareMessage = (err: unknown): string => {
    if (err instanceof IdentityUnverifiableError) {
      return err.reason === 'unreachable' ? t('identityCheckFailed') : t('identityNotReported');
    }
    return err instanceof Error ? err.message : String(err);
  };

  const handleAdd = async (host: string, port: number, protocol: 'http' | 'https', email: string, password: string) => {
    setAddError(null);
    setAddSubmitting(true);
    const existing = knowledgeBases.find(
      kb => kb.endpoint.kind === 'http' && kb.endpoint.host === host && kb.endpoint.port === port,
    );
    if (existing) {
      try {
        const { token, refreshToken, gitBranch } = await authenticateWithBackend(host, port, protocol, email, password);
        updateKnowledgeBase(existing.id, { ...(gitBranch ? { gitBranch } : {}) });
        signIn(existing.id, token, refreshToken);
        setAddForm(null);
      } catch (err) {
        setAddError(identityAwareMessage(err));
      } finally {
        setAddSubmitting(false);
      }
      return;
    }
    try {
      const { token, refreshToken, did, label, gitBranch } = await authenticateWithBackend(host, port, protocol, email, password);
      // (C) Verify the outcome against what the user believed they clicked.
      // Reports; never blocks — the KB that answered is the one they reached.
      const expectedDid = addForm?.expectedDid;
      if (expectedDid && expectedDid !== did) {
        setConnectNotice(t('connectedToOther', {
          actual: label || t('unknownName'),
          expected: addForm?.expectedName || t('unknownName'),
        }));
      }
      addKnowledgeBase(
        {
          did,
          label,
          email,
          endpoint: { kind: 'http', host, port, protocol },
          ...(gitBranch ? { gitBranch } : {}),
        },
        token,
        refreshToken,
      );
      setAddForm(null);
    } catch (err) {
      setAddError(identityAwareMessage(err));
    } finally {
      setAddSubmitting(false);
    }
  };

  const handleReauth = async (kbId: string, password: string) => {
    const kb = knowledgeBases.find(k => k.id === kbId);
    if (!kb) return;
    setReauthError(null);
    setReauthSubmitting(true);
    if (kb.endpoint.kind !== 'http') {
      setReauthError(`Re-auth is HTTP-only; KB endpoint kind "${kb.endpoint.kind}" is not supported here.`);
      setReauthSubmitting(false);
      return;
    }
    try {
      const { token, refreshToken, label, gitBranch } = await authenticateWithBackend(
        kb.endpoint.host, kb.endpoint.port, kb.endpoint.protocol, kb.email, password,
      );
      updateKnowledgeBase(kbId, { label, ...(gitBranch ? { gitBranch } : {}) });
      signIn(kbId, token, refreshToken);
      setReauthKbId(null);
    } catch (err) {
      setReauthError(err instanceof Error ? err.message : String(err));
    } finally {
      setReauthSubmitting(false);
    }
  };

  const handleKbClick = (kb: KnowledgeBase) => {
    const status = semiont.getKbSessionStatus(kb.id);
    if (status === 'authenticated') {
      setActiveKnowledgeBase(kb.id);
    } else {
      setReauthKbId(kb.id);
      setAddForm(null);
      setReauthError(null);
    }
  };

  return (
    <div className="semiont-panel">
      <div className="semiont-panel-header">
        <h2 className="semiont-panel-header__title">
          <span className="semiont-panel-header__text">{t('title')}</span>
          <span className="semiont-panel-header__count">({knowledgeBases.length})</span>
        </h2>
      </div>
      <div className="semiont-panel__content">
        <div className="semiont-panel__list">
          {knowledgeBases.map((kb: KnowledgeBase) => {
            const status = semiont.getKbSessionStatus(kb.id);
            const isActive = kb.id === activeKnowledgeBase?.id;
            const isReauthing = reauthKbId === kb.id;
            const managed = managedFor(kb);

            return (
              <div key={kb.id}>
                <div
                  className={`semiont-panel-item semiont-panel-item--clickable${isActive ? ' semiont-panel-item--selected' : ''}`}
                  style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', cursor: 'pointer', padding: '0.5rem 0.75rem' }}
                  onClick={() => handleKbClick(kb)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <StatusDot status={status} t={t} />
                    {/* Decision 7: an unnamed KB reads "Unknown" — a state, not a
                        blank — while the address stays on the address line below. */}
                    <span className="semiont-panel-text" style={{ flex: 1, fontWeight: 500 }}>{kb.label || t('unknownName')}</span>
                    {managed && <PlacementBadge placement={managed.placement} t={t} />}
                    {isActive && (
                      <CheckIcon style={{ width: '1rem', height: '1rem', color: 'var(--semiont-color-primary-500)', flexShrink: 0 }} />
                    )}
                    {status === 'authenticated' && (
                      <button
                        onClick={(e) => { e.stopPropagation(); signOut(kb.id); }}
                        title={t('signOut')}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0.125rem', color: 'var(--semiont-color-neutral-400)' }}
                      >
                        <ArrowRightStartOnRectangleIcon style={{ width: '0.875rem', height: '0.875rem' }} />
                      </button>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); setConfirmRemoveKbId(kb.id); }}
                      title={t('remove')}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0.125rem', color: 'var(--semiont-color-neutral-400)' }}
                    >
                      <TrashIcon style={{ width: '0.875rem', height: '0.875rem' }} />
                    </button>
                  </div>
                  <span className="semiont-panel-text-secondary" style={{ fontSize: '0.7rem', paddingLeft: '1rem' }}>
                    {kb.endpoint.kind === 'http'
                      ? `${kb.endpoint.host}:${kb.endpoint.port} · ${kb.gitBranch ?? MISSING}`
                      : `local:${kb.endpoint.kbId}`}
                  </span>
                  {managed && (
                    // The repo gets its own line — vertical space over width;
                    // wrap instead of the class's nowrap-ellipsis.
                    <span className="semiont-panel-text-secondary" style={{ fontSize: '0.7rem', paddingLeft: '1rem', whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
                      {managed.repo ?? MISSING}
                    </span>
                  )}
                </div>
                {confirmRemoveKbId === kb.id && (
                  <div style={{
                    padding: '0.5rem 0.75rem',
                    fontSize: '0.8rem',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    background: 'var(--semiont-bg-secondary, #f9fafb)',
                    borderBottom: '1px solid var(--semiont-color-neutral-200, #e5e7eb)',
                  }}>
                    <span style={{ flex: 1, color: 'var(--semiont-color-neutral-500)' }}>{t('removeConfirm', { label: kb.label })}</span>
                    <button
                      onClick={() => { removeKnowledgeBase(kb.id); setConfirmRemoveKbId(null); }}
                      className="semiont-button"
                      style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem', color: 'var(--semiont-color-error-500, #ef4444)' }}
                    >
                      {t('remove')}
                    </button>
                    <button
                      onClick={() => setConfirmRemoveKbId(null)}
                      className="semiont-button"
                      style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem' }}
                    >
                      {t('cancel')}
                    </button>
                  </div>
                )}
                {isReauthing && (
                  <ReauthForm
                    t={t}
                    kb={kb}
                    onSubmit={(password) => handleReauth(kb.id, password)}
                    onCancel={() => setReauthKbId(null)}
                    error={reauthError}
                    isSubmitting={reauthSubmitting}
                  />
                )}
              </div>
            );
          })}
        </div>

        {unregisteredDiscovered.length > 0 && (
          <div className="semiont-panel__list">
            <h3 className="semiont-panel-text-secondary" style={{ fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', padding: '0.5rem 0.75rem 0.25rem' }}>
              {t('discoveredTitle')}
            </h3>
            {conflictedAddresses.map(({ address, count }) => (
              <div
                key={`conflict-${address}`}
                className="semiont-panel-text-secondary"
                style={{ fontSize: '0.7rem', padding: '0 0.75rem 0.375rem', color: 'var(--semiont-color-warning-500, #eab308)', whiteSpace: 'normal' }}
              >
                ⚠ {t('addressConflict', { count, address })}
              </div>
            ))}
            {unregisteredDiscovered.map((d) => (
              <div
                /* Key on the PAIR. Decision 9's table spells out why neither
                   half works alone: a did repeats across copies of one KB, an
                   address repeats across contested claimants — and this list
                   deliberately renders both. Only did+address is unique. */
                key={`${d.did}@${endpointKey(d.host, d.port)}`}
                className="semiont-panel-item semiont-panel-item--clickable"
                style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', cursor: 'pointer', padding: '0.5rem 0.75rem' }}
                onClick={() => openAddForm({
                  host: d.host,
                  port: d.port,
                  // Record the belief so the outcome can be verified (C) —
                  // recording it is not the same as promising it (D).
                  expectedDid: d.did,
                  ...(d.siteName !== undefined ? { expectedName: d.siteName } : {}),
                })}
                {...(d.did !== undefined ? { title: d.did } : {})}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span className="semiont-panel-text" style={{ flex: 1, fontWeight: 500 }}>{d.siteName ?? MISSING}</span>
                  <PlacementBadge placement={d.placement} t={t} />
                </div>
                <span className="semiont-panel-text-secondary" style={{ fontSize: '0.7rem', paddingLeft: '1rem' }}>
                  {endpointKey(d.host, d.port)}
                </span>
                <span className="semiont-panel-text-secondary" style={{ fontSize: '0.7rem', paddingLeft: '1rem', whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
                  {d.repo ?? MISSING}
                </span>
                {isAnotherCopy(d) && (
                  <span className="semiont-panel-text-secondary" style={{ fontSize: '0.7rem', paddingLeft: '1rem', fontStyle: 'italic', whiteSpace: 'normal' }}>
                    ↳ {t('anotherCopy')}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {connectNotice && (
          <div
            className="semiont-panel-text-secondary"
            style={{ fontSize: '0.75rem', padding: '0.5rem 0.75rem', color: 'var(--semiont-color-warning-500, #eab308)', whiteSpace: 'normal' }}
          >
            {connectNotice}
          </div>
        )}

        {addForm !== null && (
          <LoginForm
            key={`${addForm.host ?? ''}:${addForm.port ?? ''}`}
            t={t}
            {...(addFormContested && addFormAddress
              ? { title: t('connectToAddress', { address: addFormAddress }) }
              : {})}
            onSubmit={handleAdd}
            onCancel={() => setAddForm(null)}
            error={addError}
            isSubmitting={addSubmitting}
            autoFocus={knowledgeBases.length === 0}
            pulsing={knowledgeBases.length === 0}
            {...(addForm.host !== undefined ? { initialHost: addForm.host } : {})}
            {...(addForm.port !== undefined ? { initialPort: addForm.port } : {})}
          />
        )}
      </div>

      {addForm === null && (
        <div className="semiont-panel-footer">
          <button
            onClick={() => openAddForm()}
            className="semiont-panel-item semiont-panel-item--clickable"
            style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--semiont-color-primary-600)' }}
          >
            <PlusIcon style={{ width: '1rem', height: '1rem', flexShrink: 0 }} />
            <span className="semiont-panel-text" style={{ color: 'inherit' }}>{t('addKnowledgeBase')}</span>
          </button>
        </div>
      )}
    </div>
  );
}
