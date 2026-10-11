/**
 * The work a Smelter plans when it starts, held to
 * specs/src/smelter/reconcile-cases.json: the table every Smelter runs, so
 * that one index, one catalog and one anchored-text store come to the same
 * work whoever plans it.
 *
 * It runs the two functions `Smelter.reconcile()` plans with and nothing else
 * of the Smelter: `classifyEmbeddable`, which asks core what each catalog
 * resource's media type means, and `planReconcile`. No bus, no store, no drain.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { ResourceDescriptor } from '@semiont/core';
import { classifyEmbeddable, planReconcile, type SmelterWorkItem } from '../smelter';
import { makeAnnotation, resourceDescriptor } from './helpers/smelter-harness';

interface IndexedResource {
  id: string;
  checksum?: string;
  entityTypes: string[];
}

interface CatalogResource {
  id: string;
  /** Absent, and the checksum with it, for a resource that has no representation. */
  mediaType?: string;
  checksum?: string;
  entityTypes: string[];
  annotations: { id: string; quote: string }[];
}

/** One item of work, in the table's words. */
type Work =
  | { kind: 'embed' | 'restamp' | 'reanchor' | 'purge'; resource: string }
  | { kind: 'embed-annotation'; annotation: string; resource: string }
  | { kind: 'purge-annotation'; annotation: string };

interface Case {
  why: string;
  index: { resources: IndexedResource[]; annotations: string[] };
  anchored: string[];
  catalog: CatalogResource[];
  work: Work[];
}

const table: { cases: Case[] } = JSON.parse(
  readFileSync(new URL('../../../../specs/src/smelter/reconcile-cases.json', import.meta.url), 'utf8'),
);

type PlanInputs = Parameters<typeof planReconcile>[0];

/**
 * A catalog resource as the descriptor the catalog answers. One that states no
 * media type has no representation at all, which the document model allows:
 * the harness's descriptor, with its representations emptied.
 */
function descriptorOf({ id, mediaType, checksum, entityTypes }: CatalogResource): ResourceDescriptor {
  const descriptor = resourceDescriptor(id, mediaType, checksum, entityTypes);
  return mediaType === undefined ? { ...descriptor, representations: [] } : descriptor;
}

/**
 * What the plan is given, built from a case as `Smelter.reconcile()` builds it
 * from its reads: the stamps as the store lists them, the catalog's resources
 * as descriptors, and each annotation with its quote where the code reads it.
 */
function inputsOf({ index, anchored, catalog }: Case): PlanInputs {
  const indexedResources: PlanInputs['indexedResources'] = new Map();
  for (const { id, checksum, entityTypes } of index.resources) {
    indexedResources.set(id, { contentChecksum: checksum, entityTypes });
  }
  return {
    indexedResources,
    indexedAnnotations: new Set(index.annotations),
    anchoredKeys: new Set(anchored),
    embeddable: classifyEmbeddable(catalog.map(descriptorOf)),
    liveAnnotations: catalog.flatMap(({ id, annotations }) =>
      annotations.map((annotation) => ({
        resourceId: id,
        annotation: makeAnnotation(id, annotation.id, annotation.quote),
      })),
    ),
  };
}

/**
 * A planned item in the table's words: the one place the code's item types
 * meet the table's kinds. A type added to `SmelterWorkItem` and not given a
 * word here fails to compile.
 */
function inTableWords(item: SmelterWorkItem): Work {
  switch (item.type) {
    case 'smelt:embed':
      return { kind: 'embed', resource: item.resourceId };
    case 'smelt:restamp':
      return { kind: 'restamp', resource: item.resourceId };
    case 'smelt:reanchor':
      return { kind: 'reanchor', resource: item.resourceId };
    case 'smelt:purge':
      return { kind: 'purge', resource: item.resourceId };
    case 'smelt:embed-annotation':
      return { kind: 'embed-annotation', annotation: item.payload.annotation.id, resource: item.resourceId };
    case 'smelt:purge-annotation':
      return { kind: 'purge-annotation', annotation: item.payload.annotationId };
    default: {
      const unworded: never = item;
      return unworded;
    }
  }
}

/** What an item is, as one string to sort by: its kind and what it is about. */
const sortKey = (work: Work): string =>
  JSON.stringify([work.kind, 'resource' in work ? work.resource : null, 'annotation' in work ? work.annotation : null]);

/**
 * Work in one order, whatever order it was planned or stated in: the table
 * states a set. A list and not a `Set`, so an item planned twice is not taken
 * for one.
 */
function inOneOrder(work: Work[]): Work[] {
  return [...work].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
}

/**
 * The one order the rule states, checked of a plan as it was returned: no
 * `embed` of a resource comes after an `embed-annotation` on that resource.
 */
function expectEmbedBeforeItsAnnotations(planned: Work[]): void {
  for (const [at, item] of planned.entries()) {
    if (item.kind !== 'embed-annotation') continue;
    const { resource, annotation } = item;
    const embedComesAfter = planned.slice(at + 1).some((later) => later.kind === 'embed' && later.resource === resource);
    expect(embedComesAfter, `the embed of ${resource} comes after the embed-annotation of ${annotation} on it`).toBe(false);
  }
}

/** Fails on a member this runner does not read, and on one it reads that is not stated. */
function expectMembers(stated: object, required: string[], optional: string[], where: string): void {
  const members = Object.keys(stated);
  expect(members.filter((member) => !required.includes(member) && !optional.includes(member)), `${where}: not read by this runner`).toEqual([]);
  expect(required.filter((member) => !members.includes(member)), `${where}: not stated`).toEqual([]);
}

/** Fails on a list that states a thing twice: the table's lists are sets. */
function expectEachOnce(list: string[], where: string): void {
  expect(new Set(list).size, `${where}: states a thing twice`).toBe(list.length);
}

describe('the work a start plans (specs/src/smelter/reconcile-cases.json)', () => {
  it('has cases, each told from the others by its why', () => {
    expect(table.cases.length).toBeGreaterThan(0);
    const whys = table.cases.map(({ why }) => why);
    expect(new Set(whys).size).toBe(whys.length);
  });

  // An unread member would be a part of a case that holds nothing, and a thing
  // stated twice in a list would be a case of what the table does not state:
  // its lists are sets. The items of `work` need no such check: each is
  // compared whole with a planned one.
  it('states nothing this runner does not read, everything it does, and nothing twice in a list', () => {
    for (const stated of table.cases) {
      const { why } = stated;
      expect(typeof why, 'why').toBe('string');
      expectMembers(stated, ['why', 'index', 'anchored', 'catalog', 'work'], [], why);
      expectMembers(stated.index, ['resources', 'annotations'], [], `${why}: index`);
      expectEachOnce(stated.index.resources.map(({ id }) => id), `${why}: index's resources`);
      expectEachOnce(stated.index.annotations, `${why}: index's annotations`);
      expectEachOnce(stated.anchored, `${why}: anchored`);
      expectEachOnce(stated.catalog.map(({ id }) => id), `${why}: catalog`);
      for (const resource of stated.index.resources) {
        expectMembers(resource, ['id', 'entityTypes'], ['checksum'], `${why}: index of ${resource.id}`);
        if ('checksum' in resource) expect(typeof resource.checksum, `${why}: index of ${resource.id}: checksum`).toBe('string');
        expectEachOnce(resource.entityTypes, `${why}: index of ${resource.id}: entityTypes`);
      }
      for (const resource of stated.catalog) {
        expectMembers(resource, ['id', 'entityTypes', 'annotations'], ['mediaType', 'checksum'], `${why}: catalog's ${resource.id}`);
        if ('mediaType' in resource) expect(typeof resource.mediaType, `${why}: catalog's ${resource.id}: mediaType`).toBe('string');
        if ('checksum' in resource) expect(typeof resource.checksum, `${why}: catalog's ${resource.id}: checksum`).toBe('string');
        // A checksum is a representation's: a resource that has none states none.
        if (!('mediaType' in resource)) expect('checksum' in resource, `${why}: catalog's ${resource.id}: a checksum and no media type`).toBe(false);
        expectEachOnce(resource.entityTypes, `${why}: catalog's ${resource.id}: entityTypes`);
        for (const annotation of resource.annotations) {
          expectMembers(annotation, ['id', 'quote'], [], `${why}: ${annotation.id}`);
          expect(typeof annotation.quote, `${why}: ${annotation.id}: quote`).toBe('string');
        }
      }
      expectEachOnce(stated.catalog.flatMap(({ annotations }) => annotations.map(({ id }) => id)), `${why}: catalog's annotations`);
    }
  });

  // The order check below holds nothing unless some plan has both.
  it('has a case that plans the embed of a resource and an embed-annotation on it', () => {
    const hasBoth = ({ work }: Case): boolean =>
      work.some((item) => {
        if (item.kind !== 'embed-annotation') return false;
        const { resource } = item;
        return work.some((other) => other.kind === 'embed' && other.resource === resource);
      });
    expect(table.cases.some(hasBoth)).toBe(true);
  });

  for (const stated of table.cases) {
    it(stated.why, () => {
      const planned = planReconcile(inputsOf(stated)).map(inTableWords);
      expectEmbedBeforeItsAnnotations(planned);
      expect(inOneOrder(planned)).toStrictEqual(inOneOrder(stated.work));
    });
  }
});
