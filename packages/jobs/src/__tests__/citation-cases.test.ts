/**
 * The citation resolver, held to specs/src/worker/citation-cases.json: the
 * table every worker's resolver runs, so that one generated text yields one
 * resolved text and one set of citations whichever language resolved it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isObject, isString, type GatheredContext, type Logger } from '@semiont/core';
import { collectCitableIds, resolveCitationTokens } from '../workers/generation/citation-resolver';

interface Citation {
  resourceId: string;
  annotationId?: string;
  start: number;
  end: number;
  exact: string;
}

interface Case {
  why: string;
  text: string;
  contextResourceIds: string[];
  contextAnnotationIds: string[];
  resolved: { text: string; citations: Citation[] };
  dropped: string[];
}

interface ContextCase {
  why: string;
  context: GatheredContext | null;
  resourceIds: string[];
  annotationIds: string[];
}

const table: { cases: Case[]; contexts: ContextCase[] } = JSON.parse(
  readFileSync(new URL('../../../../specs/src/worker/citation-cases.json', import.meta.url), 'utf8'),
);

/** A logger that keeps the id each warning names: a dropped token is warned about, and that is the only place it is said. */
function warningLogger(): { logger: Logger; warned: string[] } {
  const warned: string[] = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (_message: string, meta?: unknown) => {
      if (isObject(meta) && isString(meta.resourceId)) warned.push(meta.resourceId);
    },
    error: () => {},
    child: () => logger,
  };
  return { logger, warned };
}

describe('the citation resolver (specs/src/worker/citation-cases.json)', () => {
  it('has cases to run', () => {
    expect(table.cases.length).toBeGreaterThan(0);
    expect(table.contexts.length).toBeGreaterThan(0);
  });

  for (const { why, text, contextResourceIds, contextAnnotationIds, resolved, dropped } of table.cases) {
    it(why, () => {
      const { logger, warned } = warningLogger();
      const citable = { resourceIds: new Set(contextResourceIds), annotationIds: new Set(contextAnnotationIds) };
      const { content, citations } = resolveCitationTokens(text, citable, logger);
      expect({ text: content, citations }).toEqual(resolved);
      expect(warned).toEqual(dropped);
    });
  }

  for (const { why, context, resourceIds, annotationIds } of table.contexts) {
    it(why, () => {
      const citable = collectCitableIds(context ?? undefined);
      expect({ resourceIds: [...citable.resourceIds].sort(), annotationIds: [...citable.annotationIds].sort() }).toEqual({
        resourceIds: [...resourceIds].sort(),
        annotationIds: [...annotationIds].sort(),
      });
    });
  }
});
