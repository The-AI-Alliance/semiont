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
 * Split a query into the terms every match must satisfy. Blank input yields no
 * terms, which callers read as "no query" — a bare substring match on `" "`
 * would otherwise match every name containing a space.
 */
export function searchTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * How directly a resource answers the query: 0 exact name, 1 name prefix,
 * 2 every term present in the name, 3 the path had to supply a term.
 *
 * Path-assisted hits rank last deliberately. Someone searching "Marathon" wants
 * the document *called* Marathon before every file that merely lives under a
 * folder of that name.
 */
export function searchRank(resource: ResourceDescriptor, query: string): number {
  const whole = query.trim().toLowerCase();
  const name = (resource.name ?? '').toLowerCase();
  if (name === whole) return 0;
  if (name.startsWith(whole)) return 1;
  if (searchTerms(query).every((term) => name.includes(term))) return 2;
  return 3;
}

/**
 * Every term must appear, though each may come from the name or the path — so
 * "Aeschylus Marathon" finds a resource named for one and filed under the other.
 */
function matchesSearch(resource: ResourceDescriptor, terms: string[]): boolean {
  const name = (resource.name ?? '').toLowerCase();
  const uri = resource.storageUri?.toLowerCase() ?? '';
  return terms.every((term) => name.includes(term) || uri.includes(term));
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

  // A query of only whitespace has no terms, and so filters nothing.
  const terms = filter.search ? searchTerms(filter.search) : [];
  if (terms.length > 0) {
    matches = matches.filter((doc) => matchesSearch(doc, terms));
  }

  if (filter.archived !== undefined) {
    matches = matches.filter((doc) => (doc.archived ?? false) === filter.archived);
  }

  const search = terms.length > 0 ? filter.search! : undefined;
  const ordered = [...matches].sort(
    search
      ? (a, b) => (searchRank(a, search) - searchRank(b, search)) || compareByRecencyThenId(a, b)
      : compareByRecencyThenId,
  );

  const offset = filter.offset ?? 0;
  const limit = filter.limit ?? 20;
  return { resources: ordered.slice(offset, offset + limit), total: ordered.length };
}
