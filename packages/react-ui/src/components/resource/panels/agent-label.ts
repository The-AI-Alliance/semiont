import type { components } from '@semiont/core';

type Agent = components['schemas']['Agent'];

/**
 * Compose a display label for an Agent at render time. Software peers
 * read `${provider} ${model}` from their structured fields rather than
 * a producer-side concatenated `name`. Person/Organization fall back
 * to `name`. Unknown shapes fall back to `name` then to `@id`.
 */
export function renderAgentLabel(agent: Agent): string {
  if (agent['@type'] === 'Software') {
    const provider = (agent as { provider?: string }).provider;
    const model = (agent as { model?: string }).model;
    if (provider && model) return `${provider} ${model}`;
    if (model) return model;
    if (provider) return provider;
  }
  return agent.name || agent['@id'] || 'unknown';
}
