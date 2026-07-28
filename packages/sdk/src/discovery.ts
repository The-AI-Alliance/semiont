/**
 * Browser ↔ launcher KB discovery — the sdk domain layer (BROWSER-KB-DISCOVERY P3).
 *
 * The launcher publishes an export view of the KBs it manages
 * (`DiscoveryDocument`, served by the frontend image at `DISCOVERY_URL_PATH`).
 * This module owns every consumer-side semantic so no consumer re-derives
 * them: the one validator (core type guards, never a trusting cast), the
 * `version` compatibility gate (unknown → absent + diagnostic, never a
 * partial parse), the TYPED absent-vs-managed distinction ("no launcher
 * detected" vs "launcher manages nothing"), and the poll/diff subscription
 * (merge key `host:port` — the address is the unique field; a did names the
 * KB and is shared by its running copies).
 *
 * IO is abstracted, deliberately: `httpDiscovery` speaks the frontend
 * image's polling contract (ETag/If-None-Match → 304 short-circuit, and the
 * content-type check that makes an SPA-fallback index.html-at-200 read as
 * absent); `textDiscovery` takes a consumer-supplied text thunk — the
 * fs-free seam a Node consumer wraps its own `readFile` in. The sdk never
 * creates sessions from discovered KBs: discovery yields descriptors; auth
 * stays per-KB, user-driven.
 */

import { Observable } from 'rxjs';
import { DISCOVERY_URL_PATH, isArray, isNumber, isObject, isString } from '@semiont/core';
import type { DiscoveredKB } from '@semiont/core';

/** Why discovery reads as "no launcher detected". */
export type DiscoveryAbsentReason =
  | 'not-found'            // 404, SPA-fallback HTML, or the thunk returned null
  | 'not-json'             // body exists but is not JSON
  | 'invalid'              // JSON, but not a structurally valid DiscoveryDocument
  | 'unsupported-version'  // a version this sdk does not speak — never partially parsed
  | 'unreadable';          // the read itself failed (network, permissions)

/**
 * The typed absent-vs-managed distinction (plan refinement 2): `absent` is
 * "no launcher detected"; `managed` with an empty list is "the launcher is
 * here and manages nothing". Consumers render these differently and must
 * never have to re-derive the difference.
 */
export type DiscoveryState =
  | { kind: 'absent'; reason: DiscoveryAbsentReason; diagnostic?: string }
  | { kind: 'managed'; kbs: DiscoveredKB[] };

/** A transport read: a state, or "same as last time" (http 304). */
export type DiscoveryReadResult = DiscoveryState | { kind: 'unchanged' };

/** The two-transports-one-interface seam consumers and tests script against. */
export interface DiscoveryTransport {
  read(): Promise<DiscoveryReadResult>;
}

/** One poll's outcome: the current state plus the delta since the last emission. */
export interface DiscoveryDiff {
  state: DiscoveryState;
  added: DiscoveredKB[];
  updated: DiscoveredKB[];
  removed: DiscoveredKB[];
}

const absent = (reason: DiscoveryAbsentReason, diagnostic?: string): DiscoveryState =>
  diagnostic !== undefined ? { kind: 'absent', reason, diagnostic } : { kind: 'absent', reason };

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The one validator: text → typed state. Everything flows through here —
 * both transports, and any consumer with bytes from elsewhere.
 */
export function parseDiscoveryDocument(text: string): DiscoveryState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return absent('not-json', message(e));
  }

  if (!isObject(parsed)) return absent('invalid', 'document is not an object');

  if (!isNumber(parsed.version)) return absent('invalid', 'missing numeric "version"');
  if (parsed.version !== 1) {
    return absent(
      'unsupported-version',
      `discovery document version ${parsed.version} is newer than this client speaks (1) — refusing to partially parse`,
    );
  }

  if (!isArray(parsed.kbs)) return absent('invalid', 'missing "kbs" array');

  const kbs: DiscoveredKB[] = [];
  for (const entry of parsed.kbs) {
    if (!isObject(entry)) return absent('invalid', 'kb entry is not an object');
    const { host, port, placement, managedBy, repo, did, siteName } = entry;
    if (!isString(host) || !isString(managedBy) || !isNumber(port) || !Number.isInteger(port) || port <= 0 || port > 65535) {
      return absent('invalid', 'kb entry missing required host/port/managedBy (port must be an integer 1-65535)');
    }
    if (placement !== 'local' && placement !== 'codespace') {
      return absent('invalid', `kb entry has unknown placement ${JSON.stringify(placement)}`);
    }
    if (repo !== undefined && !isString(repo)) return absent('invalid', 'kb "repo" must be a string');
    if (siteName !== undefined && !isString(siteName)) return absent('invalid', 'kb "siteName" must be a string');
    // `did` is REQUIRED (KB-IDENTITY-VS-ADDRESS decision 8): a knowledge base
    // declares its identity or does not run. Rejecting the whole document
    // rather than skipping the entry is deliberate and matches this
    // validator's other required fields and the `version` gate — a partial
    // parse would silently hide a running KB, which is the failure class the
    // plan exists to end. In practice this means a document written by a
    // launcher older than the requirement reads as "no launcher detected"
    // until that launcher is updated, which is honest: this client cannot
    // vouch for what such a document says.
    if (!isString(did)) {
      return absent(
        'invalid',
        'kb entry has no "did" — identity is required; this document was likely written by a launcher predating that rule',
      );
    }
    kbs.push({
      host,
      port,
      placement,
      managedBy,
      did,
      ...(repo !== undefined ? { repo } : {}),
      ...(siteName !== undefined ? { siteName } : {}),
    });
  }

  return { kind: 'managed', kbs };
}

/**
 * The IO-abstracted transport: the consumer supplies the text-fetching thunk
 * (`null` = "no document there"); the sdk supplies every semantic. A Node
 * consumer's whole integration is wrapping `fs.readFile` — the sdk itself
 * never imports fs (main entry stays browser-clean).
 */
export function textDiscovery(read: () => Promise<string | null>): DiscoveryTransport {
  return {
    async read(): Promise<DiscoveryReadResult> {
      let text: string | null;
      try {
        text = await read();
      } catch (e) {
        return absent('unreadable', message(e));
      }
      if (text === null) return absent('not-found');
      return parseDiscoveryDocument(text);
    },
  };
}

/**
 * The same-origin HTTP transport, speaking the frontend image's polling
 * contract: remembers the last good ETag and sends `If-None-Match` (a 304
 * comes back as `unchanged`, short-circuiting the diff pass), and
 * content-type-checks so the SPA fallback's index.html-at-200 — the
 * pre-image-upgrade reality — reads as absent, not as junk.
 */
export function httpDiscovery(url: string = DISCOVERY_URL_PATH): DiscoveryTransport {
  let etag: string | null = null;
  return {
    async read(): Promise<DiscoveryReadResult> {
      let response: Response;
      try {
        response = await fetch(url, etag !== null ? { headers: { 'If-None-Match': etag } } : undefined);
      } catch (e) {
        return absent('unreadable', message(e));
      }
      if (response.status === 304) return { kind: 'unchanged' };
      if (!response.ok) return absent('not-found', `HTTP ${response.status}`);
      const contentType = response.headers.get('Content-Type') ?? '';
      if (!contentType.toLowerCase().includes('json')) {
        return absent('not-found', `non-JSON content-type "${contentType}" — SPA fallback (frontend image without the discovery mount?)`);
      }
      const state = parseDiscoveryDocument(await response.text());
      // Remember the validator's ETag only for a GOOD document — remembering
      // one for an invalid body would 304 us into believing it forever.
      if (state.kind === 'managed') etag = response.headers.get('ETag');
      return state;
    },
  };
}

/**
 * Merge key: the ADDRESS, which is the field the producer guarantees unique
 * (one entry per `host:port` — KB-IDENTITY-VS-ADDRESS P1/decision 5).
 *
 * NOT the did, and not `did ?? host:port`. A did says *which knowledge base*,
 * and is deliberately **not** unique: a local clone and a codespace of the
 * same repo are one KB reachable at two addresses, and both are published
 * (decision 9). Keying on it collapsed those two copies into one and made
 * the diff lie about a running stack — a phantom `updated` for the shadowed
 * copy on every poll, and a stopped copy whose removal never fired because
 * its twin kept the key alive. The did's job is verification, not selection.
 */
const keyOf = (kb: DiscoveredKB): string => `${kb.host}:${kb.port}`;

const sameKb = (a: DiscoveredKB, b: DiscoveredKB): boolean =>
  a.host === b.host && a.port === b.port && a.placement === b.placement &&
  a.managedBy === b.managedBy && a.repo === b.repo && a.did === b.did &&
  a.siteName === b.siteName;

/**
 * Poll a transport and emit DIFFS. Cold: each subscription polls
 * independently (immediate read, then every `intervalMs`) and stops on
 * unsubscribe. Emits on the first read and afterwards only when something
 * changed — a 304/`unchanged` read or an identical re-read emits nothing.
 * State transitions always emit (absent→managed carries every kb as
 * `added`; managed→absent carries them as `removed`), so a panel can render
 * "no launcher" without re-deriving it.
 */
export function subscribeDiscovery(
  transport: DiscoveryTransport,
  options?: { intervalMs?: number },
): Observable<DiscoveryDiff> {
  const intervalMs = options?.intervalMs ?? 5_000;

  return new Observable<DiscoveryDiff>((subscriber) => {
    let closed = false;
    let inflight = false;
    let last: DiscoveryState | null = null;

    const poll = async (): Promise<void> => {
      if (closed || inflight) return;
      inflight = true;
      try {
        const result = await transport.read();
        if (closed || result.kind === 'unchanged') return;

        const prevKbs = last !== null && last.kind === 'managed' ? last.kbs : [];
        const nextKbs = result.kind === 'managed' ? result.kbs : [];
        const prev = new Map(prevKbs.map((kb) => [keyOf(kb), kb]));
        const next = new Map(nextKbs.map((kb) => [keyOf(kb), kb]));

        // Two entries at ONE ADDRESS: internally inconsistent, because only
        // one process can bind a port — at most one claim is true. (Two
        // entries sharing a DID is the opposite: one KB in two places, the
        // common case, and keying on the address means it no longer reaches
        // this branch at all — decision 9.) Merging silently is how the
        // predecessor defect hid for a release: the loser vanished with no
        // trace (decision 4 — ambiguity is shown, never resolved by
        // guessing). The producer is the cure; this is the consumer refusing
        // to hide the symptom. Every entry still reaches the subscriber in
        // `state.kbs` — the diff is what collapses, so the panel can render
        // all claimants and say so.
        if (next.size !== nextKbs.length) {
          const seen = new Set<string>();
          const duplicated = [...new Set(nextKbs.map(keyOf).filter((k) => seen.size === seen.add(k).size))];
          // eslint-disable-next-line no-console
          console.warn(
            `[discovery DUPLICATE] ${nextKbs.length - next.size} entr${nextKbs.length - next.size === 1 ? 'y' : 'ies'} share a merge key ` +
              `(${duplicated.join(', ')}); at most one claim can be true. Diff membership collapses them — ` +
              'render every claimant from state.kbs rather than trusting added/removed for these.',
          );
        }

        const added = nextKbs.filter((kb) => !prev.has(keyOf(kb)));
        const removed = prevKbs.filter((kb) => !next.has(keyOf(kb)));
        const updated = nextKbs.filter((kb) => {
          const before = prev.get(keyOf(kb));
          return before !== undefined && !sameKb(before, kb);
        });

        const stateChanged =
          last === null ||
          last.kind !== result.kind ||
          (last.kind === 'absent' && result.kind === 'absent' && last.reason !== result.reason);

        if (stateChanged || added.length > 0 || updated.length > 0 || removed.length > 0) {
          last = result;
          subscriber.next({ state: result, added, updated, removed });
        }
      } finally {
        inflight = false;
      }
    };

    void poll();
    const timer = setInterval(() => { void poll(); }, intervalMs);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  });
}
