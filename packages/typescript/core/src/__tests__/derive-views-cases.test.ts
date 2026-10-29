/**
 * The flat views read off a knowledge graph, held to
 * specs/src/librarian/derive-views-cases.json: the table every
 * implementation of the reading runs, so that one graph gives one set of
 * connections, citations and sibling entity types in any language.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { deriveViews, type GraphViews } from '../knowledge-graph-views';
import { validators, formatErrors } from '../openapi';
import type { components } from '../types';

type KnowledgeGraph = components['schemas']['KnowledgeGraph'];

interface Case {
  why: string;
  graph: KnowledgeGraph;
  resource: string;
  annotation?: string;
  views: GraphViews;
}

const TABLE = 'specs/src/librarian/derive-views-cases.json';
const table: { cases: Case[] } = JSON.parse(readFileSync(new URL(`../../../../../${TABLE}`, import.meta.url), 'utf8'));

describe('the views read off a knowledge graph (specs/src/librarian/derive-views-cases.json)', () => {
  it('has cases, with a focal annotation and with none', () => {
    expect(table.cases.length).toBeGreaterThan(0);
    for (const stated of table.cases) {
      expect(typeof stated.why).toBe('string');
      expect(Object.keys(stated)).toEqual(expect.arrayContaining(['graph', 'resource', 'views']));
    }
    expect(table.cases.some((stated) => stated.annotation !== undefined)).toBe(true);
    expect(table.cases.some((stated) => stated.annotation === undefined)).toBe(true);
  });

  it('states only graphs the spec accepts', () => {
    const validate = validators.KnowledgeGraph;
    for (const stated of table.cases) {
      // A validator may write to what it reads, so it is given a copy.
      const refused = validate(structuredClone(stated.graph)) ? null : formatErrors(validate.errors);
      expect(refused, stated.why).toBeNull();
    }
  });

  it.each(table.cases)('$why', ({ graph, resource, annotation, views }) => {
    expect(deriveViews(graph, resource, annotation)).toStrictEqual(views);
  });
});
