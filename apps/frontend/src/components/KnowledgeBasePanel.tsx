import React, { useState, useEffect } from 'react';
import { CheckIcon, PlusIcon, ArrowRightStartOnRectangleIcon, XMarkIcon, TrashIcon } from '@heroicons/react/24/outline';
import { SemiontApiClient } from '@semiont/api-client';
import { baseUrl, email as makeEmail, accessToken, EventBus } from '@semiont/core';
import {
  useKnowledgeBaseContext,
  defaultProtocol,
  getKbSessionStatus,
  setKbToken,
  type KnowledgeBase,
  type KbSessionStatus,
} from '@/contexts/KnowledgeBaseContext';

function generateKbId(): string {
  return crypto.randomUUID();
}

function StatusDot({ status }: { status: KbSessionStatus }) {
  const colors: Record<KbSessionStatus, string> = {
    authenticated: 'var(--semiont-color-success-500, #22c55e)',
    expired: 'var(--semiont-color-warning-500, #eab308)',
    'signed-out': 'var(--semiont-color-neutral-400, #9ca3af)',
    unreachable: 'var(--semiont-color-error-500, #ef4444)',
  };
  const labels: Record<KbSessionStatus, string> = {
    authenticated: 'Connected',
    expired: 'Session expired',
    'signed-out': 'Signed out',
    unreachable: 'Unreachable',
  };
  return (
    <span
      title={labels[status]}
      style={{
        width: '0.5rem',
        height: '0.5rem',
        borderRadius: '50%',
        backgroundColor: colors[status],
        flexShrink: 0,
      }}
    />
  );
}

interface LoginFormProps {
  initialHost?: string;
  initialPort?: number;
  initialEmail?: string;
  onSubmit: (host: string, port: number, email: string, password: string) => Promise<void>;
  onCancel: () => void;
  error: string | null;
  isSubmitting: boolean;
  autoFocus?: boolean;
  pulsing?: boolean;
}

function LoginForm({ initialHost = 'localhost', initialPort = 4000, initialEmail = 'admin@example.com', onSubmit, onCancel, error, isSubmitting, autoFocus, pulsing }: LoginFormProps) {
  const [host, setHost] = useState(initialHost);
  const [port, setPort] = useState(String(initialPort));
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(host, parseInt(port, 10) || 4000, email, password);
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
      <h3 style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.5rem' }}>Connect to Knowledge Base</h3>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <input
            type="text"
            value={host}
            onChange={e => setHost(e.target.value)}
            placeholder="Host"
            className="semiont-input"
            style={{ flex: 1 }}
            autoFocus={autoFocus}
          />
          <input
            type="number"
            value={port}
            onChange={e => setPort(e.target.value)}
            placeholder="Port"
            className="semiont-input"
            style={{ width: '5rem' }}
          />
        </div>
        <input
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          placeholder="Email"
          className="semiont-input"
        />
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder="Password"
          className="semiont-input"
        />
        {error && (
          <div style={{ color: 'var(--semiont-color-error-500, #ef4444)', fontSize: '0.75rem' }}>{error}</div>
        )}
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button type="submit" className="semiont-button semiont-button--primary" style={{ flex: 1 }} disabled={isSubmitting}>
            {isSubmitting ? 'Connecting...' : 'Connect'}
          </button>
          <button type="button" className="semiont-button" onClick={onCancel}>
            <XMarkIcon style={{ width: '1rem', height: '1rem' }} />
          </button>
        </div>
      </form>
    </div>
  );
}

interface ReauthFormProps {
  kb: KnowledgeBase;
  onSubmit: (password: string) => Promise<void>;
  onCancel: () => void;
  error: string | null;
  isSubmitting: boolean;
}

function ReauthForm({ kb, onSubmit, onCancel, error, isSubmitting }: ReauthFormProps) {
  const [password, setPassword] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(password);
  };

  return (
    <form onSubmit={handleSubmit} style={{ padding: '0.5rem 0.75rem', display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
      <div style={{ fontSize: '0.75rem', color: 'var(--semiont-color-neutral-400)' }}>{kb.email}</div>
      <input
        type="password"
        value={password}
        onChange={e => setPassword(e.target.value)}
        placeholder="Password"
        className="semiont-input"
        style={{ fontSize: '0.8rem' }}
        autoFocus
      />
      {error && (
        <div style={{ color: 'var(--semiont-color-error-500, #ef4444)', fontSize: '0.75rem' }}>{error}</div>
      )}
      <div style={{ display: 'flex', gap: '0.375rem' }}>
        <button type="submit" className="semiont-button semiont-button--primary" style={{ flex: 1, fontSize: '0.8rem' }} disabled={isSubmitting}>
          {isSubmitting ? 'Signing in...' : 'Sign in'}
        </button>
        <button type="button" className="semiont-button" onClick={onCancel} style={{ fontSize: '0.8rem' }}>
          Cancel
        </button>
      </div>
    </form>
  );
}

async function authenticateWithBackend(host: string, port: number, protocol: 'http' | 'https', emailStr: string, password: string): Promise<{ token: string; label: string }> {
  const origin = `${protocol}://${host}:${port}`;
  const client = new SemiontApiClient({ baseUrl: baseUrl(origin), eventBus: new EventBus() });

  const authResult = await client.authenticatePassword(makeEmail(emailStr), password);
  const token = (authResult as any).token ?? (authResult as any).accessToken;
  if (!token) throw new Error('No token received');

  let label = `${host}:${port}`;
  try {
    const status = await client.getStatus({ auth: accessToken(token) });
    if ((status as any).projectName) label = (status as any).projectName;
  } catch { /* use default label */ }

  return { token, label };
}

export function KnowledgeBasePanel() {
  const { knowledgeBases, activeKnowledgeBase, setActiveKnowledgeBase, addKnowledgeBase, removeKnowledgeBase, updateKnowledgeBase, signOut } = useKnowledgeBaseContext();
  const [showAddForm, setShowAddForm] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addSubmitting, setAddSubmitting] = useState(false);
  const [reauthKbId, setReauthKbId] = useState<string | null>(null);
  const [reauthError, setReauthError] = useState<string | null>(null);
  const [reauthSubmitting, setReauthSubmitting] = useState(false);
  const [, setTick] = useState(0);

  // Auto-open add form on first launch (no KBs)
  useEffect(() => {
    if (knowledgeBases.length === 0) {
      setShowAddForm(true);
    }
  }, [knowledgeBases.length]);

  const [confirmRemoveKbId, setConfirmRemoveKbId] = useState<string | null>(null);

  // Periodic status refresh
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 30_000);
    return () => clearInterval(interval);
  }, []);

  const openAddForm = () => {
    setShowAddForm(true);
    setReauthKbId(null); // close any re-auth form
    setAddError(null);
  };

  const handleAdd = async (host: string, port: number, email: string, password: string) => {
    setAddError(null);
    setAddSubmitting(true);
    const protocol = defaultProtocol(host);

    // Deduplicate: if a KB with the same host+port exists, re-auth it instead
    const existing = knowledgeBases.find(kb => kb.host === host && kb.port === port);
    if (existing) {
      try {
        const { token } = await authenticateWithBackend(host, port, protocol, email, password);
        setKbToken(existing.id, token);
        setActiveKnowledgeBase(existing.id);
        setShowAddForm(false);
      } catch (err) {
        setAddError(err instanceof Error ? err.message : String(err));
      } finally {
        setAddSubmitting(false);
      }
      return;
    }

    try {
      const { token, label } = await authenticateWithBackend(host, port, protocol, email, password);
      const id = generateKbId();
      setKbToken(id, token);
      addKnowledgeBase({ id, label, host, port, protocol, email });
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
      const { token, label } = await authenticateWithBackend(kb.host, kb.port, kb.protocol, kb.email, password);
      setKbToken(kbId, token);
      updateKnowledgeBase(kbId, { label });
      setReauthKbId(null);
      setActiveKnowledgeBase(kbId);
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
      setShowAddForm(false); // close add form
      setReauthError(null);
    }
  };

  return (
    <div className="semiont-panel">
      <div className="semiont-panel-header">
        <h2 className="semiont-panel-header__title">
          <span className="semiont-panel-header__text">Knowledge Bases</span>
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
                  style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}
                  onClick={() => handleKbClick(kb)}
                >
                  <StatusDot status={status} />
                  <span className="semiont-panel-text" style={{ flex: 1 }}>{kb.label}</span>
                  <span className="semiont-panel-text-secondary" style={{ fontSize: '0.7rem' }}>
                    {kb.host}:{kb.port}
                  </span>
                  {isActive && (
                    <CheckIcon style={{ width: '1rem', height: '1rem', color: 'var(--semiont-color-primary-500)', flexShrink: 0 }} />
                  )}
                  {status === 'authenticated' && (
                    <button
                      onClick={(e) => { e.stopPropagation(); signOut(kb.id); }}
                      title="Sign out"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0.125rem', color: 'var(--semiont-color-neutral-400)' }}
                    >
                      <ArrowRightStartOnRectangleIcon style={{ width: '0.875rem', height: '0.875rem' }} />
                    </button>
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); setConfirmRemoveKbId(kb.id); }}
                    title="Remove"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0.125rem', color: 'var(--semiont-color-neutral-400)' }}
                  >
                    <TrashIcon style={{ width: '0.875rem', height: '0.875rem' }} />
                  </button>
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
                    <span style={{ flex: 1, color: 'var(--semiont-color-neutral-500)' }}>Remove {kb.label}?</span>
                    <button
                      onClick={() => { removeKnowledgeBase(kb.id); setConfirmRemoveKbId(null); }}
                      className="semiont-button"
                      style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem', color: 'var(--semiont-color-error-500, #ef4444)' }}
                    >
                      Remove
                    </button>
                    <button
                      onClick={() => setConfirmRemoveKbId(null)}
                      className="semiont-button"
                      style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem' }}
                    >
                      Cancel
                    </button>
                  </div>
                )}
                {isReauthing && (
                  <ReauthForm
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
            <span className="semiont-panel-text" style={{ color: 'inherit' }}>Add knowledge base</span>
          </button>
        </div>
      )}
    </div>
  );
}
