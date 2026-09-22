/**
 * People Projection Reader
 *
 * Who the DIDs in this knowledge base's record belong to. Maintained by
 * ViewMaterializer in response to `person:profiled` events, which the gateway
 * produces when a person ACTS, from the name it verified on their token.
 *
 * This is the read side of PERSON-PROFILE: provenance joins on the DID alone
 * and no artifact carries a name, so a reader resolves one here. That is what
 * makes a rename correct every artifact its subject ever wrote, instead of
 * leaving the old name frozen in each of them.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { SYSTEM_SCOPE } from '@semiont/core';
import type { SemiontState } from '@semiont/core/node';
import type { PeopleView } from '@semiont/event-sourcing';

/**
 * Read the people projection: DID → current profile.
 *
 * An absent file is an empty map, the same "no such events yet" case the
 * entity-type reader answers — never an error, and never a fabricated name.
 * A DID with no entry stays unnamed: the record says what it knows.
 */
export async function readPeopleProjection(state: SemiontState): Promise<PeopleView> {
  const peoplePath = path.join(
    state.stateDir,
    'projections',
    SYSTEM_SCOPE,
    'people.json'
  );

  try {
    const content = await fs.readFile(peoplePath, 'utf-8');
    const projection = JSON.parse(content);
    return projection.people || {};
  } catch (error: any) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

/**
 * Fill in the names of the people a reply mentions.
 *
 * Structural rather than path-listed on purpose. Agents appear in a dozen
 * shapes across the Browser's replies — an annotation's `creator`, a
 * descriptor's `wasAttributedTo` array, a directory entry's metadata, whatever
 * the next reply adds — and a hand-written list of those paths is a mirror of
 * a fact the schemas own, with nothing to keep the two in step. Walking for
 * `@type: 'Person'` covers every one of them, including shapes added later.
 *
 * This is the ONE place a Person acquires a name (`didToAgent` deliberately
 * leaves it absent), which is what keeps the name resolvable to a single
 * source. It also OVERRIDES a stored name rather than only filling an absent
 * one: artifacts written before this existed carry the subject UUID where a
 * name belongs, and they must read correctly too — that is the whole benefit
 * of resolving on read rather than freezing at write.
 *
 * A DID with no profile is left unnamed. The knowledge base says what it
 * knows, and a client renders the absence however it likes.
 *
 * Returns the SAME reference when nothing changed, so a reply mentioning no
 * person costs a walk and no allocation.
 */
export function resolvePersonNames<T>(value: T, people: PeopleView): T {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const resolved = resolvePersonNames(item, people);
      if (resolved !== item) changed = true;
      return resolved;
    });
    return (changed ? next : value) as T;
  }

  if (value === null || typeof value !== 'object') return value;

  const record = value as Record<string, unknown>;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    const resolved = resolvePersonNames(item, people);
    if (resolved !== item) changed = true;
    next[key] = resolved;
  }

  if (record['@type'] === 'Person') {
    const profile = people[String(record['@id'])];
    if (profile && next['name'] !== profile.name) {
      next['name'] = profile.name;
      changed = true;
    }
  }

  return (changed ? next : value) as T;
}
