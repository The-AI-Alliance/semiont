import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ToolSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';

import { TOOLS } from './tools.js';

/** What one row of the README's "Available tools" tables says of a tool. */
interface DocumentedTool {
  required: string[];
  optional: string[];
  /** The defaults the row states, by parameter. */
  defaults: Record<string, string>;
}

/** A table row's cells, without the two empty ones its outer pipes make. */
function cellsOf(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

/** The code spans of a piece of Markdown. */
function codeSpans(markdown: string): string[] {
  return markdown.split('`').filter((_, i) => i % 2 === 1);
}

/** The parameters a cell names. A parenthesis after a name describes it and names nothing. */
function paramsIn(cell: string): string[] {
  return codeSpans(cell.replace(/\([^)]*\)/g, ''));
}

/** The defaults a cell states: each `name` (default `value`). */
function defaultsIn(cell: string): Record<string, string> {
  const defaults: Record<string, string> = {};
  for (const [, name, value] of cell.matchAll(/`([^`]+)` \(default `([^`]+)`\)/g)) {
    defaults[name] = value;
  }
  return defaults;
}

/**
 * The tools the README documents, read from the tables under "Available
 * tools". Anything there this cannot read is an error, never a tool with no
 * parameters: a table with no `Tool` or `Required` column, a row whose cells
 * do not match its header, a row that names no tool.
 */
function documentedTools(readme: string): Map<string, DocumentedTool> {
  const lines = readme.split('\n');
  const start = lines.indexOf('## Available tools');
  if (start === -1) throw new Error('README.md has no "Available tools" section');
  const next = lines.findIndex((line, i) => i > start && line.startsWith('## '));
  const section = lines.slice(start + 1, next === -1 ? undefined : next);

  const documented = new Map<string, DocumentedTool>();
  let header: string[] | undefined;
  for (const line of section) {
    if (!line.startsWith('|')) {
      header = undefined;
      continue;
    }
    const cells = cellsOf(line);
    if (cells.every((cell) => /^-+$/.test(cell))) continue;
    if (!header) {
      if (!cells.includes('Tool') || !cells.includes('Required')) {
        throw new Error(`a table under "Available tools" has no Tool or no Required column: ${line}`);
      }
      header = cells;
      continue;
    }
    if (cells.length !== header.length) {
      throw new Error(`a row under "Available tools" does not match its header: ${line}`);
    }
    const [name] = codeSpans(cells[header.indexOf('Tool')]);
    if (!name) throw new Error(`a row under "Available tools" names no tool: ${line}`);
    if (documented.has(name)) throw new Error(`"Available tools" documents ${name} twice`);

    // A table with no Optional column documents tools that take none.
    const optionalAt = header.indexOf('Optional');
    const optional = optionalAt === -1 ? '' : cells[optionalAt];
    documented.set(name, {
      required: paramsIn(cells[header.indexOf('Required')]),
      optional: paramsIn(optional),
      defaults: defaultsIn(optional),
    });
  }
  return documented;
}

/** What a tool tells a model about one of its parameters. */
function descriptionOf(tool: Tool, param: string): string {
  const property: unknown = tool.inputSchema.properties?.[param];
  if (typeof property !== 'object' || property === null
    || !('description' in property) || typeof property.description !== 'string') {
    throw new Error(`${tool.name} does not describe ${param}`);
  }
  return property.description;
}

const DOCUMENTED = documentedTools(readFileSync(new URL('../README.md', import.meta.url), 'utf-8'));

describe('TOOLS', () => {
  it('registers exactly the tools the README documents, in its order', () => {
    expect(TOOLS.map((tool) => tool.name)).toEqual([...DOCUMENTED.keys()]);
  });

  it('is valid against the MCP tool schema', () => {
    for (const tool of TOOLS) {
      expect(() => ToolSchema.parse(tool)).not.toThrow();
    }
  });

  it.each(TOOLS.map((tool) => [tool.name, tool] as const))('declares %s with the parameters the README documents', (name, tool) => {
    const documented = DOCUMENTED.get(name);
    if (!documented) throw new Error(`${name} is not in the README's "Available tools"`);

    expect(tool.inputSchema.required ?? []).toEqual(documented.required);
    expect(Object.keys(tool.inputSchema.properties ?? {}).sort())
      .toEqual([...documented.required, ...documented.optional].sort());
  });

  it.each(TOOLS.map((tool) => [tool.name, tool] as const))('tells a model the defaults the README states for %s', (name, tool) => {
    const documented = DOCUMENTED.get(name);
    if (!documented) throw new Error(`${name} is not in the README's "Available tools"`);

    for (const [param, value] of Object.entries(documented.defaults)) {
      expect(descriptionOf(tool, param), `${name}.${param}`).toContain(`(default: ${value})`);
    }
  });

  it('requires all of a selection: its offset and its length, whole numbers of at least zero, and its text, which is not empty', () => {
    const selection: unknown = TOOLS.find((tool) => tool.name === 'mark_annotation')?.inputSchema.properties?.['selectionData'];

    expect(selection).toMatchObject({
      type: 'object',
      properties: {
        offset: { type: 'integer', minimum: 0 },
        length: { type: 'integer', minimum: 0 },
        text: { type: 'string', minLength: 1 },
      },
      required: ['offset', 'length', 'text'],
    });
  });

  it('gives every tool a description', () => {
    for (const tool of TOOLS) {
      expect(tool.description, tool.name).toBeTruthy();
    }
  });
});
