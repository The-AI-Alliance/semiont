import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckIcon, PlusIcon, ArrowRightStartOnRectangleIcon, XMarkIcon, TrashIcon } from '@heroicons/react/24/outline';
import { defaultProtocol, isValidHostname, type KnowledgeBase, type KbSessionStatus } from '@semiont/sdk';
import { usePathname } from '@/i18n/routing';
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

/**
 * Where to connect. Who the user is comes from the issuer the knowledge base
 * trusts, so the form asks for an address and nothing else; "Connect" sends
 * the user to sign in there.
 */
function ConnectForm({ t, title, onSubmit, onCancel, error, isSubmitting, autoFocus, pulsing, initialHost = 'localhost', initialPort = 4000 }: {
  t: T;
  /** Overrides the generic heading — used to announce a contested ADDRESS (D). */
  title?: string;
  onSubmit: (host: string, port: number, protocol: 'http' | 'https') => Promise<void>;
  onCancel: () => void;
  error: string | null;
  isSubmitting: boolean;
  autoFocus?: boolean;
  pulsing?: boolean;
  initialHost?: string;
  initialPort?: number;
}) {
  const [host, setHost] = useState(initialHost);
  const [port, setPort] = useState(String(initialPort));
  const [protocol, setProtocol] = useState<'http' | 'https'>(defaultProtocol(initialHost));

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
      <form onSubmit={(e) => { e.preventDefault(); if (isValidHostname(host)) onSubmit(host, parseInt(port, 10) || 4000, protocol); }} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <select value={protocol} onChange={e => setProtocol(e.target.value as 'http' | 'https')} className="semiont-input">
          <option value="http">HTTP</option>
          <option value="https">HTTPS</option>
        </select>
        <input type="text" value={host} onChange={e => handleHostChange(e.target.value)} placeholder="Host" className="semiont-input" autoFocus={autoFocus} />
        <input type="number" value={port} onChange={e => setPort(e.target.value)} placeholder="Port" className="semiont-input" />
        {host && !isValidHostname(host) && (
          <div style={{ color: 'var(--semiont-color-error-500, #ef4444)', fontSize: '0.75rem' }}>{t('invalidHost')}</div>
        )}
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

/** A registered KB whose session ended: one button back to its issuer. */
function ReauthPrompt({ t, onSubmit, onCancel, error, isSubmitting }: {
  t: T;
  onSubmit: () => Promise<void>;
  onCancel: () => void;
  error: string | null;
  isSubmitting: boolean;
}) {
  return (
    <div style={{ padding: '0.5rem 0.75rem', display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
      {error && <div style={{ color: 'var(--semiont-color-error-500, #ef4444)', fontSize: '0.75rem' }}>{error}</div>}
      <div style={{ display: 'flex', gap: '0.375rem' }}>
        <button type="button" className="semiont-button semiont-button--primary" style={{ flex: 1, fontSize: '0.8rem' }} disabled={isSubmitting} onClick={() => { void onSubmit(); }}>
          {isSubmitting ? t('signingIn') : t('signIn')}
        </button>
        <button type="button" className="semiont-button" onClick={onCancel} style={{ fontSize: '0.8rem' }}>
          {t('cancel')}
        </button>
      </div>
    </div>
  );
}

export function KnowledgeBasePanel() {
  const pathname = usePathname();
  const { t: _t, i18n } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`KnowledgeBasePanel.${k}`, p as any) as string;
  const semiont = useSemiont();
  const knowledgeBases = useObservable(semiont.kbs$) ?? [];
  const activeKnowledgeBase = useObservable(semiont.activeSession$)?.kb ?? null;
  const setActiveKnowledgeBase = (id: string) => {
    // Leave a resource route BEFORE switching. The URL carries the CURRENT
    // KB's resource id, which identifies nothing in the KB we're moving to —
    // loading it there earns a 404 and the B14/B15 retry-then-fail chain, and
    // a "Try Again" that can never succeed.
    //
    // This has to happen here, at the initiator. The resource page cannot
    // infer it after the fact: `KnowledgeLayout` gates `<Outlet />` on a live
    // session, so the page is unmounted the moment `activeSession$` goes null
    // and remounts fresh against the new KB — from its own point of view no
    // switch ever happened.
    // See .plans/bugs/resource-page-frozen-on-disposed-client-after-kb-switch.md
    if (pathname.startsWith('/know/resource/')) {
      semiont.emit('nav:push', { path: '/know', reason: 'kb-switch' });
    }
    void semiont.setActiveKb(id);
  };
  const removeKnowledgeBase = semiont.removeKb.bind(semiont);
  const signOut = (id: string) => { void semiont.signOut(id); };
  // The issuer sends the user back here; the callback page completes the
  // sign-in. The redirect is registered per origin at the issuer, so it is
  // this Browser's own address, not the knowledge base's.
  const redirectUri = () => `${window.location.origin}/${i18n.language}/auth/callback`;
  // null = closed; {} = blank form; {host, port} = prefilled from a discovered
  // row. `expected*` records WHAT THE USER BELIEVED they were connecting to, so
  // the outcome can be verified against the KB that actually answers (C).
  const [addForm, setAddForm] = useState<
    { host?: string; port?: number; expectedDid?: string; expectedName?: string } | null
  >(null);
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
  };

  // Connecting is leaving: the sign-in happens at the issuer the KB trusts,
  // and the callback page registers the KB when the user returns — with the
  // identity the KB reports, verified against what they believed they
  // clicked (C). A registered KB at the typed address is re-authenticated
  // rather than duplicated.
  const handleAdd = async (host: string, port: number, protocol: 'http' | 'https') => {
    setAddError(null);
    setAddSubmitting(true);
    const existing = knowledgeBases.find(
      kb => kb.endpoint.kind === 'http' && kb.endpoint.host === host && kb.endpoint.port === port,
    );
    try {
      const url = await semiont.beginSignIn({
        target: { kind: 'http', host, port, protocol },
        redirectUri: redirectUri(),
        ...(existing ? { kbId: existing.id } : {}),
        ...(addForm?.expectedDid ? { expectedDid: addForm.expectedDid } : {}),
        ...(addForm?.expectedName ? { expectedName: addForm.expectedName } : {}),
      });
      window.location.assign(url);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
      setAddSubmitting(false);
    }
  };

  const handleReauth = async (kbId: string) => {
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
      const url = await semiont.beginSignIn({ target: kb.endpoint, redirectUri: redirectUri(), kbId });
      window.location.assign(url);
    } catch (err) {
      setReauthError(err instanceof Error ? err.message : String(err));
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
                  <ReauthPrompt
                    t={t}
                    onSubmit={() => handleReauth(kb.id)}
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

        {addForm !== null && (
          <ConnectForm
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
