import type { LogEntry } from '../components/ChatPane';

/**
 * Named chat sessions, one conversation each, grouped by KB. Persisted via the same
 * bridge as before (Electron XDG `history.json` / web localStorage). Supersedes the old
 * one-log-per-KB `chat-history.ts`; the old shape is migrated on first load.
 *
 * App owns the sessions array in state; this module just loads, saves (terminal entries
 * only — an in-flight turn isn't resumable), and provides pure helpers.
 */
export interface AppChatSession {
  id: string;
  kbUri: string;
  /** User label; null means "auto" (shown as the first message's words, else "New chat"). */
  name: string | null;
  createdAt: number;
  updatedAt: number;
  entries: LogEntry[];
}

interface SessionStore {
  sessions: Record<string, AppChatSession>;
}

const STORE_KEY = 'semiont-desktop.history';
const OLD_STORE_KEY = 'document-grounded-chat.history';

// Persist resting entries: uploads, errors, and finished answers (whether or not marked —
// 'answered' is the resting state; marking happens on demand and accrues onto it).
const isTerminal = (e: LogEntry): boolean =>
  e.kind === 'upload' || e.status === 'answered' || e.status === 'error';

async function readRaw(): Promise<string | null> {
  if (typeof window !== 'undefined' && window.historyBridge) return window.historyBridge.read();
  if (typeof localStorage !== 'undefined') return localStorage.getItem(STORE_KEY) ?? localStorage.getItem(OLD_STORE_KEY);
  return null;
}

async function writeRaw(json: string): Promise<void> {
  if (typeof window !== 'undefined' && window.historyBridge) {
    await window.historyBridge.write(json);
    return;
  }
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(STORE_KEY, json);
    localStorage.removeItem(OLD_STORE_KEY);
  }
}

const isNewShape = (parsed: unknown): parsed is SessionStore =>
  parsed !== null && typeof parsed === 'object' && 'sessions' in parsed && typeof (parsed as SessionStore).sessions === 'object';

/**
 * Parse whatever is stored into sessions. New shape passes through; the old
 * `{ [kbUri]: LogEntry[] }` map becomes one session per non-empty KB log. Pure (aside
 * from id/timestamp generation), so it's unit-testable.
 */
export function migrateToSessions(parsed: unknown): AppChatSession[] {
  if (isNewShape(parsed)) return Object.values(parsed.sessions);
  if (parsed === null || typeof parsed !== 'object') return [];
  const now = Date.now();
  const sessions: AppChatSession[] = [];
  for (const [kbUri, entries] of Object.entries(parsed as Record<string, unknown>)) {
    if (Array.isArray(entries) && entries.length > 0) {
      sessions.push({
        id: crypto.randomUUID(),
        kbUri,
        name: null,
        createdAt: now,
        updatedAt: now,
        entries: (entries as LogEntry[]).filter(isTerminal),
      });
    }
  }
  return sessions;
}

export async function loadSessions(): Promise<AppChatSession[]> {
  let parsed: unknown = {};
  try {
    const raw = await readRaw();
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = {};
  }
  const sessions = migrateToSessions(parsed);
  if (!isNewShape(parsed)) await saveSessions(sessions); // persist the migrated shape once
  return sessions;
}

export async function saveSessions(sessions: AppChatSession[]): Promise<void> {
  try {
    const store: SessionStore = { sessions: {} };
    for (const s of sessions) store.sessions[s.id] = { ...s, entries: s.entries.filter(isTerminal) };
    await writeRaw(JSON.stringify(store));
  } catch {
    // best-effort — history loss is non-fatal
  }
}

/** A fresh, empty session for a KB. */
export function newSession(kbUri: string): AppChatSession {
  const now = Date.now();
  return { id: crypto.randomUUID(), kbUri, name: null, createdAt: now, updatedAt: now, entries: [] };
}

/** A KB's sessions, newest activity first. */
export function sessionsForKb(sessions: AppChatSession[], kbUri: string): AppChatSession[] {
  return sessions.filter((s) => s.kbUri === kbUri).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Display title: the user's name, else the first message's words, else "New chat". */
export function sessionTitle(s: AppChatSession): string {
  if (s.name && s.name.trim()) return s.name.trim();
  const firstQuestion = s.entries.find((e): e is Extract<LogEntry, { kind: 'qna' }> => e.kind === 'qna');
  if (firstQuestion) {
    const words = firstQuestion.question.trim().split(/\s+/).slice(0, 6).join(' ');
    if (words) return words.length > 48 ? `${words.slice(0, 48)}…` : words;
  }
  return 'New chat';
}
