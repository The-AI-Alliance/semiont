import { describe, it, expect } from 'vitest';
import { migrateToSessions, sessionsForKb, sessionTitle, newSession, type AppChatSession } from './chat-sessions';
import type { LogEntry } from '../components/ChatPane';

const answeredTurn = (question: string): LogEntry => ({
  kind: 'qna',
  id: crypto.randomUUID(),
  question,
  status: 'answered',
  phaseStartedAt: 0,
});

describe('migrateToSessions', () => {
  it('converts an old { [kbUri]: LogEntry[] } map into one session per non-empty KB', () => {
    const sessions = migrateToSessions({
      'http://a': [answeredTurn('Q1'), answeredTurn('Q2')],
      'http://b': [answeredTurn('Q3')],
      'http://empty': [],
    });
    expect(sessions).toHaveLength(2); // the empty KB is skipped
    const a = sessions.find((s) => s.kbUri === 'http://a');
    expect(a?.entries).toHaveLength(2);
    expect(a?.name).toBeNull();
  });

  it('passes a new-shape store through unchanged', () => {
    const s: AppChatSession = { id: 's1', kbUri: 'http://a', name: 'Named', createdAt: 1, updatedAt: 2, entries: [] };
    expect(migrateToSessions({ sessions: { s1: s } })).toEqual([s]);
  });

  it('returns [] for junk', () => {
    expect(migrateToSessions(null)).toEqual([]);
    expect(migrateToSessions('nope')).toEqual([]);
  });
});

describe('sessionsForKb', () => {
  it('filters by KB and sorts newest-updated first', () => {
    const mk = (id: string, kbUri: string, updatedAt: number): AppChatSession => ({
      id,
      kbUri,
      name: null,
      createdAt: 0,
      updatedAt,
      entries: [],
    });
    const all = [mk('1', 'http://a', 10), mk('2', 'http://b', 20), mk('3', 'http://a', 30)];
    expect(sessionsForKb(all, 'http://a').map((s) => s.id)).toEqual(['3', '1']);
  });
});

describe('sessionTitle', () => {
  const base: AppChatSession = { id: 'x', kbUri: 'k', name: null, createdAt: 0, updatedAt: 0, entries: [] };
  it('uses the name when set', () => {
    expect(sessionTitle({ ...base, name: 'My chat' })).toBe('My chat');
  });
  it('derives from the first question when unnamed', () => {
    expect(sessionTitle({ ...base, entries: [answeredTurn('What does TCP stand for?')] })).toBe('What does TCP stand for?');
  });
  it('falls back to "New chat" when empty', () => {
    expect(sessionTitle(base)).toBe('New chat');
  });
});

describe('newSession', () => {
  it('is empty, unnamed, for the given KB', () => {
    const s = newSession('http://a');
    expect(s.kbUri).toBe('http://a');
    expect(s.name).toBeNull();
    expect(s.entries).toEqual([]);
    expect(typeof s.id).toBe('string');
  });
});
