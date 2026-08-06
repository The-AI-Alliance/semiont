/**
 * The resource query — filtering, ranking and pagination — expressed in JS.
 *
 * Shared by every backend whose engine does not express it directly (memory,
 * JanusGraph, Neptune) so those three cannot drift apart. Neo4j expresses the
 * same semantics in Cypher, and the interface contract tests pin both shapes to
 * one behaviour.
 */

import { getResourceEntityTypes } from '@semiont/core';
import type { ResourceDescriptor, ResourceFilter } from '@semiont/core';
import { compareByRecencyThenId } from './interface';

/**
 * How directly a resource answers the query: 0 exact name, 1 name prefix,
 * 2 name substring, 3 matched on `storageUri` alone.
 *
 * Path-only hits rank last deliberately. Someone searching "Marathon" wants the
 * document *called* Marathon before every file that merely lives under a folder
 * of that name.
 */
export function searchRank(resource: ResourceDescriptor, query: string): number {
  const needle = query.toLowerCase();
  const name = (resource.name ?? '').toLowerCase();
  if (name === needle) return 0;
  if (name.startsWith(needle)) return 1;
  if (name.includes(needle)) return 2;
  return 3;
}

function matchesSearch(resource: ResourceDescriptor, query: string): boolean {
  const needle = query.toLowerCase();
  return (resource.name ?? '').toLowerCase().includes(needle)
    || (resource.storageUri?.toLowerCase().includes(needle) ?? false);
}

/**
 * Filter, order and page a resource set. Filters always run before pagination,
 * so `total` describes the match set rather than the page.
 */
export function queryResources(
  all: ResourceDescriptor[],
  filter: ResourceFilter,
): { resources: ResourceDescriptor[]; total: number } {
  let matches = all;

  if (filter.entityTypes && filter.entityTypes.length > 0) {
    matches = matches.filter((doc) =>
      filter.entityTypes!.some((type) => getResourceEntityTypes(doc).includes(type)));
  }

  if (filter.search) {
    matches = matches.filter((doc) => matchesSearch(doc, filter.search!));
  }

  if (filter.archived !== undefined) {
    matches = matches.filter((doc) => (doc.archived ?? false) === filter.archived);
  }

  const { search } = filter;
  const ordered = [...matches].sort(
    search
      ? (a, b) => (searchRank(a, search) - searchRank(b, search)) || compareByRecencyThenId(a, b)
      : compareByRecencyThenId,
  );

  const offset = filter.offset ?? 0;
  const limit = filter.limit ?? 20;
  return { resources: ordered.slice(offset, offset + limit), total: ordered.length };
}
