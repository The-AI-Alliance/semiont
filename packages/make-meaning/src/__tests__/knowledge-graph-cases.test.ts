/**
 * The knowledge graph built for one resource, held to
 * specs/src/librarian/knowledge-graph-cases.json: the table every Librarian
 * runs, so that what the graph store and the views answer gives one graph,
 * or one failure, in any language.
 *
 * The stores are fakes that answer what a case states. The applied signal is
 * real: a case that states it has it emitted on a bus before the build, and
 * a case that does not leaves the barrier to its timeout. The waits run on
 * fake timers, so `waited` is exact.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { validators, formatErrors } from '@semiont/core/openapi';
import {
  EventBus,
  resourceId,
  type Annotation,
  type GraphConnection,
  type ResourceDescriptor,
  type components,
} from '@semiont/core';
import { GraphContext, type KnowledgeGraphReads } from '../graph-context';
import { createWeaveProgress } from '../weave-progress';

type KnowledgeGraph = components['schemas']['KnowledgeGraph'];
type ResourceView = components['schemas']['ResourceView'];

interface Case {
  why: string;
  resource: string;
  graph: {
    resource: (ResourceDescriptor | null)[];
    connections: { resource: ResourceDescriptor; relationshipType?: string; bidirectional: boolean }[];
    referencedBy: Annotation[];
    annotations: Annotation[];
  };
  views: Record<string, ResourceView>;
  applied: boolean;
  knowledgeGraph?: KnowledgeGraph;
  fails?: 'unknown' | 'behind';
  waited: number;
}

const TABLE = 'specs/src/librarian/knowledge-graph-cases.json';
const table: { cases: Case[] } = JSON.parse(readFileSync(new URL(`../../../../${TABLE}`, import.meta.url), 'utf8'));

/** What the error of each kind of failure says. */
const FAILURES: Record<NonNullable<Case['fails']>, string> = {
  unknown: 'Resource not found',
  behind: 'Graph projection did not catch up',
};

/** Why the spec refuses `value` as one of its types, or null where it does not. A validator may write to what it reads, so it is given a copy. */
function refused(schema: 'ResourceDescriptor' | 'Annotation' | 'ResourceView' | 'KnowledgeGraph', value: unknown): string | null {
  const validate = validators[schema];
  return validate(structuredClone(value)) ? null : formatErrors(validate.errors);
}

describe('the knowledge graph of a resource (specs/src/librarian/knowledge-graph-cases.json)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('has cases, each stating a graph or a failure and never both', () => {
    expect(table.cases.length).toBeGreaterThan(0);
    for (const stated of table.cases) {
      expect(typeof stated.why).toBe('string');
      expect([stated.knowledgeGraph !== undefined, stated.fails !== undefined].filter(Boolean), stated.why).toHaveLength(1);
    }
    expect(table.cases.some((stated) => stated.fails === 'unknown')).toBe(true);
    expect(table.cases.some((stated) => stated.fails === 'behind')).toBe(true);
    expect(table.cases.some((stated) => stated.applied)).toBe(true);
  });

  it('states only objects the spec accepts', () => {
    for (const stated of table.cases) {
      for (const answer of stated.graph.resource) {
        if (answer !== null) expect(refused('ResourceDescriptor', answer), stated.why).toBeNull();
      }
      for (const connection of stated.graph.connections) {
        expect(refused('ResourceDescriptor', connection.resource), stated.why).toBeNull();
      }
      for (const annotation of [...stated.graph.referencedBy, ...stated.graph.annotations]) {
        expect(refused('Annotation', annotation), stated.why).toBeNull();
      }
      for (const view of Object.values(stated.views)) {
        expect(refused('ResourceView', view), stated.why).toBeNull();
      }
      if (stated.knowledgeGraph !== undefined) {
        expect(refused('KnowledgeGraph', stated.knowledgeGraph), stated.why).toBeNull();
      }
    }
  });

  it.each(table.cases)('$why', async (given) => {
    const answers = given.graph.resource;
    let asked = 0;
    const connections: GraphConnection[] = given.graph.connections.map(({ resource, ...rest }) => ({
      targetResource: resource,
      annotations: [],
      ...rest,
    }));

    const bus = new EventBus();
    const weaveProgress = createWeaveProgress(bus);
    if (given.applied) {
      const view = given.views[given.resource];
      if (view === undefined) throw new Error('the case states an applied signal for a resource that has no view');
      bus.emit('weave:applied', { resourceId: resourceId(given.resource), sequenceNumber: view.lastSequence });
    }

    const kb: KnowledgeGraphReads = {
      graph: {
        getResource: async () => {
          const answer = answers[asked];
          if (answer === undefined) throw new Error(`asked for the resource more than the ${answers.length} times the case states an answer for`);
          asked += 1;
          return answer;
        },
        getResourceConnections: async () => connections,
        getResourceReferencedBy: async () => given.graph.referencedBy,
        getResourceAnnotations: async () => given.graph.annotations,
      },
      views: { get: async (id) => given.views[id] ?? null },
      weaveProgress,
    };

    const start = Date.now();
    // Settled into a value before any timer runs, so a failure is never a
    // rejection nothing is yet waiting on.
    const settled = GraphContext.buildKnowledgeGraph(resourceId(given.resource), kb).then(
      (graph) => ({ graph, waited: Date.now() - start }),
      (error: unknown) => ({ error, waited: Date.now() - start }),
    );
    await vi.runAllTimersAsync();
    const outcome = await settled;
    weaveProgress.dispose();
    bus.destroy();

    if (given.fails !== undefined) {
      if (!('error' in outcome)) throw new Error('a graph was built where the case states a failure');
      expect(outcome.error).toBeInstanceOf(Error);
      expect(String(outcome.error)).toContain(FAILURES[given.fails]);
    } else {
      if (!('graph' in outcome)) throw outcome.error;
      expect(outcome.graph).toStrictEqual(given.knowledgeGraph);
    }
    expect(outcome.waited).toBe(given.waited);
    expect(asked).toBe(answers.length);
  });
});
