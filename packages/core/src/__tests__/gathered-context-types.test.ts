/**
 * Type-level guard — CONTEXT-UNIFICATION P1.
 *
 * One `GatheredContext`: a shared base plus a discriminated `focus`
 * (annotation | resource). A resource-focus context carries no `annotation`,
 * and `focus.kind` narrows. The `graph` is the shared `KnowledgeGraph` whose
 * node `type` is the `resource | annotation` enum.
 *
 * Enforced by `tsc --noEmit` (core `typecheck`), not vitest runtime. The
 * resource-focus case is RED on the pre-P1 generated type (`annotation`
 * required, no `focus`) and GREEN after the reshape + regen.
 */
import { describe, it, expect } from 'vitest';
import type { components } from '../types';

type GatheredContext = components['schemas']['GatheredContext'];
type KnowledgeGraph = components['schemas']['KnowledgeGraph'];
type ResourceDescriptor = components['schemas']['ResourceDescriptor'];
type Annotation = components['schemas']['Annotation'];

const aResource = {} as ResourceDescriptor;
const anAnnotation = {} as Annotation;
const aGraph: KnowledgeGraph = { nodes: [], edges: [] };

describe('GatheredContext — unified shape (P1)', () => {
  it('accepts a resource-focus context (no annotation)', () => {
    const ctx: GatheredContext = {
      focus: { kind: 'resource', resource: aResource, summary: 'a doc' },
      graph: aGraph,
      metadata: {},
    };
    expect(ctx.focus.kind).toBe('resource');
  });

  it('narrows focus on kind (annotation branch carries annotation + userHint)', () => {
    const ctx: GatheredContext = {
      focus: {
        kind: 'annotation',
        annotation: anAnnotation,
        sourceResource: aResource,
        selected: { text: 'passage' },
        userHint: 'a hint',
      },
      graph: aGraph,
      metadata: {},
    };
    if (ctx.focus.kind === 'annotation') {
      expect(ctx.focus.selected?.text).toBe('passage');
      expect(ctx.focus.userHint).toBe('a hint');
    }
  });

  it('shared base: graph is KnowledgeGraph; entityTypeFrequencies on metadata', () => {
    const ctx: GatheredContext = {
      focus: { kind: 'resource', resource: aResource },
      graph: aGraph,
      metadata: { entityTypeFrequencies: { Person: 3 }, language: 'en' },
      inferredRelationshipSummary: 'relates to X',
      semanticContext: { similar: [] },
    };
    expect(ctx.metadata?.entityTypeFrequencies?.Person).toBe(3);
  });

  it('KnowledgeGraph nodes use the resource|annotation enum and optional metadata', () => {
    const g: KnowledgeGraph = {
      nodes: [
        { id: 'r-1', type: 'resource', label: 'R' },
        { id: 'a-1', type: 'annotation', label: 'A', entityTypes: ['Person'] },
      ],
      edges: [{ source: 'a-1', target: 'r-1', type: 'annotation-of', bidirectional: false }],
    };
    expect(g.nodes[0]!.type).toBe('resource');
    expect(g.edges[0]!.bidirectional).toBe(false);
  });
});

// ── P1b: annotation-wrapper collapse ──────────────────────────────────────────
// The annotation focus carries the (dormant) target* capability that used to
// live on the now-deleted per-kind annotation-response wrapper; the gather:annotation
// channels now carry a bare GatheredContext, symmetric with the resource path.
type GatherAnnotationComplete = components['schemas']['GatherAnnotationComplete'];
type GatherAnnotationFinished = components['schemas']['GatherAnnotationFinished'];

describe('GatheredContext — annotation-wrapper collapse (P1b)', () => {
  it('annotation focus accepts targetResource? / targetContext?', () => {
    const ctx: GatheredContext = {
      focus: {
        kind: 'annotation',
        annotation: anAnnotation,
        sourceResource: aResource,
        targetResource: aResource,
        targetContext: { content: 'target body', summary: 'gist' },
      },
      graph: aGraph,
      metadata: {},
    };
    if (ctx.focus.kind === 'annotation') {
      expect(ctx.focus.targetContext?.content).toBe('target body');
    }
  });

  it('gather:annotation channel responses are a bare GatheredContext', () => {
    const ctx: GatheredContext = {
      focus: { kind: 'annotation', annotation: anAnnotation, sourceResource: aResource },
      graph: aGraph,
      metadata: {},
    };
    const complete: GatherAnnotationComplete = { correlationId: 'c', annotationId: 'a-1', response: ctx };
    const finished: GatherAnnotationFinished = { correlationId: 'c', annotationId: 'a-1', response: ctx };
    expect(complete.response.focus.kind).toBe('annotation');
    expect(finished.response.focus.kind).toBe('annotation');
  });
});
