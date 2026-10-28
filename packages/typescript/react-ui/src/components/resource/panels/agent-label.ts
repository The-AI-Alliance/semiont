import type { components } from '@semiont/core';

type Agent = components['schemas']['Agent'];

/**
 * Compose a display label for an Agent at render time. Software peers
 * read `${provider} ${model}` from their structured fields rather than
 * a producer-side concatenated `name`. Person/Organization fall back
 * to `name`. Unknown shapes fall back to `name` then to `@id`. An agent
 * with none of these has no label.
 */
export function renderAgentLabel(agent: Agent): string | undefined {
  if (agent['@type'] === 'Software') {
    const provider = (agent as { provider?: string }).provider;
    const model = (agent as { model?: string }).model;
    if (provider && model) return `${provider} ${model}`;
    if (model) return model;
    if (provider) return provider;
  }
  return agent.name || agent['@id'];
}

/** The labels of one agent or of several, joined. Empty when none of them has a label. */
export function renderAgentLabels(agents: Agent | Agent[]): string {
  return (Array.isArray(agents) ? agents : [agents])
    .map(renderAgentLabel)
    .filter((label) => label !== undefined)
    .join(', ');
}

/** The name an annotation's creator goes by, when it has one. */
export function creatorName(creator: Agent | string | undefined): string | undefined {
  return typeof creator === 'string' ? creator : creator?.name;
}
