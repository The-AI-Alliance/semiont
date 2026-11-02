import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { isObject, isString, isArray } from '@semiont/core';
import { httpKb, type KbTarget } from '@semiont/sdk';

/** A configured Semiont knowledge base: where it answers, keyed by its uri. It holds no
 *  credentials: signing in happens at the knowledge base's issuer (see `connect`).
 *  The KB's own identity (name + branch) comes from the knowledge base, not here. */
export interface KbEntry {
  uri: string;
  /** Optional user label — shown in the nav and, when set, appended to the KB's real
   *  identity below the chat bar. NOT the KB's identity (see `browse.kb()`). */
  alias?: string;
}

/** The per-user runtime config: the KBs the user has set up. Which KBs are connected lives
 *  in prefs (app state), not here. */
export interface UserConfig {
  kbs: KbEntry[];
}

export const EMPTY_USER_CONFIG: UserConfig = { kbs: [] };

export interface KbCoordinates {
  host: string;
  port: number;
  protocol: 'http' | 'https';
}

/** Split a KB uri (e.g. `http://localhost:4000`) into host/port/protocol. Throws on a bad uri. */
export function parseKbUri(uri: string): KbCoordinates {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new Error(`kb uri is not a valid URL: ${uri}`);
  }
  const protocol = url.protocol.replace(/:$/, '');
  if (protocol !== 'http' && protocol !== 'https') {
    throw new Error(`kb uri must be http or https (got "${protocol}")`);
  }
  if (!url.hostname) throw new Error(`kb uri has no host: ${uri}`);
  const port = url.port ? Number(url.port) : protocol === 'https' ? 443 : 80;
  return { host: url.hostname, port, protocol };
}

function parseKbEntry(raw: unknown): KbEntry[] {
  if (!isObject(raw) || !isString(raw.uri)) return [];
  const entry: KbEntry = { uri: raw.uri };
  if (isString(raw.alias)) entry.alias = raw.alias;
  return [entry];
}

/** Parse the runtime config TOML. Defensive — malformed input yields an empty config
 *  rather than throwing. */
export function parseUserConfig(toml: string): UserConfig {
  let root: unknown;
  try {
    root = parseToml(toml);
  } catch {
    return { ...EMPTY_USER_CONFIG };
  }
  if (!isObject(root)) return { ...EMPTY_USER_CONFIG };
  return { kbs: isArray(root.kb) ? root.kb.flatMap(parseKbEntry) : [] };
}

/** Serialize back to TOML (for the XDG file / localStorage). */
export function serializeUserConfig(config: UserConfig): string {
  const root: Record<string, unknown> = {
    kb: config.kbs.map((k) => {
      const o: Record<string, unknown> = { uri: k.uri };
      if (k.alias !== undefined) o.alias = k.alias;
      return o;
    }),
  };
  return stringifyToml(root);
}

/** The session target of a configured KB, or null if its uri is malformed. Its `id` is the
 *  address (`host:port`): it names the stored session, so two entries at one address share
 *  a sign-in. */
export function kbTargetFor(kb: KbEntry): KbTarget | null {
  try {
    const { host, port, protocol } = parseKbUri(kb.uri);
    return httpKb({ id: `${host}:${port}`, label: kb.alias ?? host, host, port, protocol });
  } catch {
    return null;
  }
}
