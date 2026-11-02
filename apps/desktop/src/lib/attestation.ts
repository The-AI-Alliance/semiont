import type { Annotation, components } from '@semiont/core';

type Agent = components['schemas']['Agent'];
type Engine = components['schemas']['Engine'];
type User = components['schemas']['UserResponse'];

/**
 * Provenance display helpers — the Browser's panel-entry conventions, shared by the
 * delegation form's done state and the annotation hovercard:
 *   "By {creator} · {relative time}"  — the requesting actor (W3C `creator`)
 *   "Via {provider model}"            — the software peer(s) (W3C `generator`)
 */

/** Software agents render from structured provider/model (never a concatenated name);
 *  everyone else by name, then @id. */
export function agentLabel(agent: Agent): string {
  if (agent['@type'] === 'Software') {
    const { provider, model } = agent as { provider?: string; model?: string };
    if (provider !== undefined && model !== undefined) return `${provider} ${model}`;
    if (model !== undefined) return model;
  }
  return agent.name ?? String(agent['@id'] ?? 'unknown');
}

/** An engine renders as a Software agent does: provider, then model. */
export function engineLabel(engine: Engine): string {
  return `${engine.provider} ${engine.model}`;
}

/** Whoever is signed in renders by the name the knowledge base holds for them, and by their
 *  DID when it holds none, as a Person agent does. */
export function userLabel(user: User): string {
  return user.name ?? user.did;
}

/** "just now" / "45m ago" / "9h ago" / "3d ago" / a locale date beyond a week. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (seconds < 120) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export interface Attestation {
  by: string;
  when?: string;
  via?: string;
}

/** The attestation an annotation carries — null when it has no provenance at all.
 *  `creator` is widened to admit legacy string creators (the Browser's panels guard for
 *  the same — older event-log data predates the typed Agent). */
export function attestationOf(
  annotation: {
    creator?: Annotation['creator'] | string;
    generator?: Annotation['generator'];
    created?: Annotation['created'];
  },
  now: number = Date.now(),
): Attestation | null {
  const { creator, generator, created } = annotation;
  if (creator === undefined && generator === undefined && created === undefined) return null;

  const by = typeof creator === 'string' ? creator : creator !== undefined ? agentLabel(creator) : 'unknown';
  const via =
    generator === undefined
      ? undefined
      : (Array.isArray(generator) ? generator : [generator]).map(agentLabel).join(', ');
  const when = created !== undefined ? relativeTime(created, now) : undefined;

  return {
    by,
    ...(via !== undefined ? { via } : {}),
    ...(when !== undefined ? { when } : {}),
  };
}
