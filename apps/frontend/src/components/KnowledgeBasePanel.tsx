import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckIcon, PlusIcon, ArrowRightStartOnRectangleIcon, XMarkIcon, TrashIcon } from '@heroicons/react/24/outline';
import { SemiontApiClient } from '@semiont/api-client';
import { baseUrl, email as makeEmail, accessToken } from '@semiont/core';
import {
  useSemiont,
  useObservable,
  defaultProtocol,
  isValidHostname,
  getKbSessionStatus,
  type KnowledgeBase,
  type KbSessionStatus,
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

function LoginForm({ t, onSubmit, onCancel, error, isSubmitting, autoFocus, pulsing, initialHost = 'localhost', initialPort = 4000, initialEmail = 'admin@example.com' }: {
  t: T;
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
      <h3 style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.5rem' }}>{t('connectTitle')}</h3>
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

async function authenticateWithBackend(host: string, port: number, protocol: 'http' | 'https', emailStr: string, password: string): Promise<{ token: string; refreshToken: string; label: string; gitBranch?: string }> {
  const origin = `${protocol}://${host}:${port}`;
  const client = new SemiontApiClient({ baseUrl: baseUrl(origin) });

  const authResult = await client.authenticatePassword(makeEmail(emailStr), password);
  const token = (authResult as any).token ?? (authResult as any).accessToken;
  const refreshToken = (authResult as any).refreshToken;
  if (!token) throw new Error('No access token received');
  if (!refreshToken) throw new Error('No refresh token received');

  let label = `${host}:${port}`;
  let gitBranch: string | undefined;
  try {
    const status = await client.getStatus({ auth: accessToken(token) });
    if ((status as any).projectName) label = (status as any).projectName;
    if ((status as any).gitBranch) gitBranch = (status as any).gitBranch;
  } catch { /* use default label */ }

  return { token, refreshToken, label, ...(gitBranch ? { gitBranch } : {}) };
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
  const [showAddForm, setShowAddForm] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addSubmitting, setAddSubmitting] = useState(false);
  const [reauthKbId, setReauthKbId] = useState<string | null>(null);
  const [reauthError, setReauthError] = useState<string | null>(null);
  const [reauthSubmitting, setReauthSubmitting] = useState(false);
  const [confirmRemoveKbId, setConfirmRemoveKbId] = useState<string | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (knowledgeBases.length === 0) setShowAddForm(true);
  }, [knowledgeBases.length]);

  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 30_000);
    return () => clearInterval(interval);
  }, []);

  const openAddForm = () => {
    setShowAddForm(true);
    setReauthKbId(null);
    setAddError(null);
  };

  const handleAdd = async (host: string, port: number, protocol: 'http' | 'https', email: string, password: string) => {
    setAddError(null);
    setAddSubmitting(true);
    const existing = knowledgeBases.find(kb => kb.host === host && kb.port === port);
    if (existing) {
      try {
        const { token, refreshToken, gitBranch } = await authenticateWithBackend(host, port, protocol, email, password);
        updateKnowledgeBase(existing.id, { ...(gitBranch ? { gitBranch } : {}) });
        signIn(existing.id, token, refreshToken);
        setShowAddForm(false);
      } catch (err) {
        setAddError(err instanceof Error ? err.message : String(err));
      } finally {
        setAddSubmitting(false);
      }
      return;
    }
    try {
      const { token, refreshToken, label, gitBranch } = await authenticateWithBackend(host, port, protocol, email, password);
      addKnowledgeBase({ label, host, port, protocol, email, ...(gitBranch ? { gitBranch } : {}) }, token, refreshToken);
      setShowAddForm(false);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setAddSubmitting(false);
    }
  };

  const handleReauth = async (kbId: string, password: string) => {
    const kb = knowledgeBases.find(k => k.id === kbId);
    if (!kb) return;
    setReauthError(null);
    setReauthSubmitting(true);
    try {
      const { token, refreshToken, label, gitBranch } = await authenticateWithBackend(kb.host, kb.port, kb.protocol, kb.email, password);
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
    const status = getKbSessionStatus(kb.id);
    if (status === 'authenticated') {
      setActiveKnowledgeBase(kb.id);
    } else {
      setReauthKbId(kb.id);
      setShowAddForm(false);
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
            const status = getKbSessionStatus(kb.id);
            const isActive = kb.id === activeKnowledgeBase?.id;
            const isReauthing = reauthKbId === kb.id;

            return (
              <div key={kb.id}>
                <div
                  className={`semiont-panel-item semiont-panel-item--clickable${isActive ? ' semiont-panel-item--selected' : ''}`}
                  style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', cursor: 'pointer', padding: '0.5rem 0.75rem' }}
                  onClick={() => handleKbClick(kb)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <StatusDot status={status} t={t} />
                    <span className="semiont-panel-text" style={{ flex: 1, fontWeight: 500 }}>{kb.label}</span>
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
                    {kb.host}:{kb.port}{kb.gitBranch ? ` · ${kb.gitBranch}` : ''}
                  </span>
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

        {showAddForm && (
          <LoginForm
            t={t}
            onSubmit={handleAdd}
            onCancel={() => setShowAddForm(false)}
            error={addError}
            isSubmitting={addSubmitting}
            autoFocus={knowledgeBases.length === 0}
            pulsing={knowledgeBases.length === 0}
          />
        )}
      </div>

      {!showAddForm && (
        <div className="semiont-panel-footer">
          <button
            onClick={openAddForm}
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
