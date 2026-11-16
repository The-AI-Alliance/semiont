import { describe, expect, it } from 'vitest';
import { ToolSchema } from '@modelcontextprotocol/sdk/types.js';

import { TOOLS } from './tools.js';

/**
 * The catalogue as the README documents it ("Available tools"). Written out
 * here rather than derived from `TOOLS`, so a parameter that drifts in the
 * source without a README edit fails this file.
 */
const DOCUMENTED: Record<string, { required: string[]; optional: string[] }> = {
  browse_resource:       { required: ['id'], optional: [] },
  browse_resources:      { required: [], optional: ['search', 'archived', 'limit'] },
  browse_highlights:     { required: ['resourceId'], optional: [] },
  browse_references:     { required: ['resourceId'], optional: [] },
  mark_annotation:       { required: ['resourceId', 'selectionData'], optional: ['entityTypes'] },
  mark_assist:           { required: ['resourceId'], optional: ['entityTypes', 'language', 'sourceLanguage'] },
  bind_body:             { required: ['sourceResourceId', 'annotationId', 'targetResourceId'], optional: [] },
  gather_annotation:     { required: ['resourceId', 'annotationId'], optional: ['contextWindow'] },
  yield_resource:        { required: ['name', 'content', 'storageUri'], optional: ['entityTypes', 'contentType'] },
  yield_from_annotation: { required: ['resourceId', 'annotationId', 'storageUri'], optional: ['title', 'prompt', 'language', 'sourceLanguage'] },
};

describe('TOOLS', () => {
  it('exposes exactly the ten documented tools', () => {
    expect(TOOLS.map(t => t.name)).toEqual(Object.keys(DOCUMENTED));
  });

  it('is valid against the MCP tool schema', () => {
    for (const tool of TOOLS) {
      expect(() => ToolSchema.parse(tool)).not.toThrow();
    }
  });

  it.each(Object.entries(DOCUMENTED))('declares %s with the documented parameters', (name, expected) => {
    const tool = TOOLS.find(t => t.name === name);
    if (!tool) throw new Error(`${name} is not registered`);

    expect(tool.inputSchema.required ?? []).toEqual(expected.required);
    expect(Object.keys(tool.inputSchema.properties ?? {}).sort())
      .toEqual([...expected.required, ...expected.optional].sort());
  });

  it('gives every tool a description', () => {
    for (const tool of TOOLS) {
      expect(tool.description, tool.name).toBeTruthy();
    }
  });
});
