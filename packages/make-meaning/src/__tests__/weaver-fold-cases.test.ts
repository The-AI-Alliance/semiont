/**
 * The Weaver's fold, held to specs/src/weaver/fold-cases.json: the table every
 * implementation of the Weaver runs. A case is a history of recorded events
 * and the graph it must leave, so the rule of each event is stated once and
 * not once per language.
 *
 * Every event of the table is first proved to be one the bus could carry: a
 * StoredEventResponse, with the payload the bus registry names for its
 * channel. A fixture that is not a recorded event proves nothing about what
 * the fold does with one.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { validators, formatErrors } from '@semiont/core/openapi';
import type { Annotation, ResourceDescriptor, StoredEvent } from '@semiont/core';
import type { GraphDatabase } from '@semiont/graph';
import { DEFAULT_ENTITY_TYPES } from '@semiont/ontology';
import { buildWeaverRig } from './helpers/weaver-harness';

interface RecordedEvent {
  id: string;
  type: string;
  timestamp: string;
  userId: string;
  resourceId?: string;
  version: number;
  payload: Record<string, unknown>;
  metadata: { sequenceNumber: number };
}

interface Graph {
  resources: ResourceDescriptor[];
  annotations: Annotation[];
  entityTypesAdded: string[];
}

interface Case {
  why: string;
  history: RecordedEvent[];
  graph: Graph;
  applied: Record<string, number>;
  refused?: number;
}

const read = (path: string) => JSON.parse(readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8'));

const table: { cases: Case[] } = read('specs/src/weaver/fold-cases.json');

/** The payload schema the bus registry names for each recorded event. */
const registry: { channels: Array<{ event?: string; shape?: string; payload?: string }> } = read('specs/src/bus/registry.json');
const payloadSchemaOf = new Map(
  registry.channels.flatMap((c) => (c.shape === 'storedEvent' && c.event && c.payload ? [[c.event, c.payload] as const] : [])),
);

function holds(schema: string, value: unknown, what: string): void {
  const validate = Object.entries(validators).find(([name]) => name === schema)?.[1];
  if (!validate) throw new Error(`${what}: the spec has no schema ${schema}`);
  if (!validate(value)) throw new Error(`${what} is not a ${schema}: ${formatErrors(validate.errors)}`);
}

/** A table event, as the Weaver is given one. */
function recorded(event: RecordedEvent): StoredEvent {
  const what = `${event.type} ${event.id}`;
  holds('StoredEventResponse', event, what);
  const payloadSchema = payloadSchemaOf.get(event.type);
  if (!payloadSchema) throw new Error(`${what}: the bus registry names no recorded event of that type`);
  holds(payloadSchema, event.payload, `${what}'s payload`);
  // The one cast: the table is JSON, and the two checks above are what make
  // it the event the type says it is.
  return event as unknown as StoredEvent;
}

const byId = <T>(id: (item: T) => string) => (a: T, b: T) => id(a).localeCompare(id(b));

/** A graph with every set in one order, so two that hold the same things are equal. */
function ordered(graph: Graph): Graph {
  return {
    resources: graph.resources
      .map((resource) => ({ ...resource, entityTypes: [...(resource.entityTypes ?? [])].sort() }))
      .sort(byId((resource) => String(resource['@id']))),
    annotations: [...graph.annotations].sort(byId((annotation) => String(annotation.id))),
    entityTypesAdded: [...graph.entityTypesAdded].sort(),
  };
}

async function held(graph: GraphDatabase): Promise<Graph> {
  const { resources } = await graph.listResources({ limit: 1_000 });
  const annotations: Annotation[] = [];
  for (const resource of resources) annotations.push(...(await graph.getResourceAnnotations(resource['@id'])));
  const entityTypesAdded = (await graph.getEntityTypes()).filter((type) => !DEFAULT_ENTITY_TYPES.includes(type));
  return ordered({ resources, annotations, entityTypesAdded });
}

describe('specs/src/weaver/fold-cases.json', () => {
  it('states graphs the spec allows: every resource a ResourceDescriptor, every annotation an Annotation', () => {
    for (const c of table.cases) {
      for (const resource of c.graph.resources) holds('ResourceDescriptor', resource, `${c.why}: resource ${resource['@id']}`);
      for (const annotation of c.graph.annotations) holds('Annotation', annotation, `${c.why}: annotation ${annotation.id}`);
    }
  });

  it.each(table.cases)('$why', async (c) => {
    const rig = await buildWeaverRig();
    const history = c.history.map(recorded);
    const expected = ordered(c.graph);

    const asStated = async () => {
      for (const [resource, sequence] of Object.entries(c.applied)) {
        expect(rig.weaver.appliedUpTo(resource), `applied up to, for ${resource}`).toBe(sequence);
      }
      expect(rig.weaver.getHealthMetrics().applyFailures, 'events refused').toBe(c.refused ?? 0);
      expect(await held(rig.graph)).toEqual(expected);
    };

    try {
      for (const event of history) rig.push(event);

      await vi.waitFor(asStated, { timeout: 3_000, interval: 5 });
      // And it stays so: a mark that passes a refused event, or an event
      // applied a second time, would show only after the graph first matched.
      await new Promise((resolve) => setTimeout(resolve, 50));
      await asStated();
    } finally {
      await rig.dispose();
    }
  });
});
