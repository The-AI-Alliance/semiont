import type { components } from '@semiont/core';

type Agent = components['schemas']['Agent'];

/**
 * Compose a display label for an Agent at render time. An agent's `name`
 * is what its profile says it is called, filled in when the record is read.
 * A Software agent is labeled by its name followed by the provider and model
 * it says it runs, `my-highlighter (anthropic claude-haiku-4-5)`, and by
 * whichever of these it has when it lacks the others. Every agent falls back
 * to its `@id`. An agent with none of these has no label.
 */
export function renderAgentLabel(agent: Agent): string | undefined {
  if (agent['@type'] === 'Software') {
    const engine = [agent.provider, agent.model].filter(Boolean).join(' ');
    if (agent.name && engine) return `${agent.name} (${engine})`;
    return agent.name || engine || agent['@id'];
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
