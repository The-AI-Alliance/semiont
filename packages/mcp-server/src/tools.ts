/**
 * Tool definitions — the `tools/list` payload.
 *
 * Data only, so the catalogue can be read without booting the stdio server.
 * Every name here has a matching `case` in `callTool` (handlers.ts) and a row
 * in the README's "Available tools", which tools.test.ts reads: a tool's
 * parameters, and each default its row states, are held to that table.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export const TOOLS: Tool[] = [
  // ── Browse ────────────────────────────────────────────────────────
  {
    name: 'browse_resource',
    description: 'Get a resource\'s descriptor by ID',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Resource ID' } }, required: ['id'] },
  },
  {
    name: 'browse_resources',
    description: 'List resources with optional filters',
    inputSchema: {
      type: 'object',
      properties: {
        archived: { type: 'boolean', description: 'Filter by archived status (default: false)' },
        limit: { type: 'number', description: 'Maximum results (default: 50)' },
      },
    },
  },
  {
    name: 'browse_highlights',
    description: 'Get highlighting annotations for a resource',
    inputSchema: { type: 'object', properties: { resourceId: { type: 'string' } }, required: ['resourceId'] },
  },
  {
    name: 'browse_references',
    description: 'Get linking annotations for a resource',
    inputSchema: { type: 'object', properties: { resourceId: { type: 'string' } }, required: ['resourceId'] },
  },
  // ── Mark ──────────────────────────────────────────────────────────
  {
    name: 'mark_annotation',
    description: 'Create a highlight annotation on a resource, with each entity type as a tagging body',
    inputSchema: {
      type: 'object',
      properties: {
        resourceId: { type: 'string', description: 'Resource ID' },
        selectionData: { type: 'object', description: "The selection: its offset and its length, both counted in Unicode code points of the resource's text, and the text selected", properties: { offset: { type: 'integer', minimum: 0 }, length: { type: 'integer', minimum: 0 }, text: { type: 'string', minLength: 1 } }, required: ['offset', 'length', 'text'] },
        entityTypes: { type: 'array', items: { type: 'string' }, description: 'Entity types, each added to the annotation as a tagging body' },
      },
      required: ['resourceId', 'selectionData'],
    },
  },
  {
    name: 'mark_delegate',
    description: 'Delegated annotation: have the worker detect entity references in a resource',
    inputSchema: {
      type: 'object',
      properties: {
        resourceId: { type: 'string', description: 'Resource ID' },
        entityTypes: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Entity types to detect: at least one, each registered in the knowledge base' },
        language: { type: 'string', description: 'BCP-47 tag for the annotation body language (what the LLM writes). Stamped on TextualBody.language.' },
        sourceLanguage: { type: 'string', description: 'BCP-47 tag for the source-resource language. Fed into the prompt for source-aware analysis.' },
      },
      required: ['resourceId', 'entityTypes'],
    },
  },
  // ── Bind ──────────────────────────────────────────────────────────
  {
    name: 'bind_body',
    description: 'Link a reference annotation to a target resource',
    inputSchema: {
      type: 'object',
      properties: {
        sourceResourceId: { type: 'string', description: 'Resource containing the annotation' },
        annotationId: { type: 'string', description: 'Annotation ID to link' },
        targetResourceId: { type: 'string', description: 'Target resource to link to' },
      },
      required: ['sourceResourceId', 'annotationId', 'targetResourceId'],
    },
  },
  // ── Match ─────────────────────────────────────────────────────────
  {
    name: 'match_resources',
    description: 'Search resources by text: by title and metadata, or by meaning when nothing matches the text',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search query' },
        archived: { type: 'boolean', description: 'Filter by archived status (default: false)' },
        limit: { type: 'number', description: 'Maximum results (default: 50)' },
      },
      required: ['search'],
    },
  },
  // ── Gather ────────────────────────────────────────────────────────
  {
    name: 'gather_annotation',
    description: 'Gather LLM context for an annotation (passage + graph context)',
    inputSchema: {
      type: 'object',
      properties: {
        resourceId: { type: 'string' },
        annotationId: { type: 'string' },
        contextWindow: { type: 'number', description: 'Character window (default: 2000)' },
      },
      required: ['resourceId', 'annotationId'],
    },
  },
  // ── Yield ─────────────────────────────────────────────────────────
  {
    name: 'yield_resource',
    description: 'Create a new resource from content',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Resource name' },
        content: { type: 'string', description: 'Resource content' },
        storageUri: { type: 'string', description: 'Storage URI (e.g. file://docs/my-resource.md)' },
        entityTypes: { type: 'array', items: { type: 'string' }, description: 'Entity types' },
        contentType: { type: 'string', description: 'MIME type (default: text/plain)' },
      },
      required: ['name', 'content', 'storageUri'],
    },
  },
  {
    name: 'yield_from_annotation',
    description: 'Generate a new resource from an annotation using AI',
    inputSchema: {
      type: 'object',
      properties: {
        resourceId: { type: 'string' },
        annotationId: { type: 'string' },
        title: { type: 'string', description: 'Title of the generated resource (default: Generated)' },
        storageUri: { type: 'string' },
        prompt: { type: 'string', description: 'AI generation prompt' },
        language: { type: 'string', description: 'BCP-47 tag — language the generated resource is written in.' },
        sourceLanguage: { type: 'string', description: 'BCP-47 tag — language of the source resource the annotation lives on. Defaults to the gathered context metadata.' },
      },
      required: ['resourceId', 'annotationId', 'storageUri'],
    },
  },
];
