#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListPromptsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { HttpContentTransport, HttpTransport, SemiontClient } from '@semiont/api-client';
import { baseUrl, accessToken } from '@semiont/core';
import { BehaviorSubject } from 'rxjs';

import * as handlers from './handlers.js';

/**
 * Semiont MCP Server
 *
 * Exposes the Semiont verb-oriented API to AI applications via MCP tools.
 * Tools are named by flow: browse, mark, bind, gather, match, yield.
 */

if (!process.env.SEMIONT_API_URL) {
  throw new Error('SEMIONT_API_URL environment variable is required');
}
if (!process.env.SEMIONT_ACCESS_TOKEN) {
  throw new Error('SEMIONT_ACCESS_TOKEN environment variable is required');
}

const SEMIONT_API_URL = process.env.SEMIONT_API_URL;
const SEMIONT_ACCESS_TOKEN = process.env.SEMIONT_ACCESS_TOKEN;
const token = accessToken(SEMIONT_ACCESS_TOKEN);

const transport = new HttpTransport({
  baseUrl: baseUrl(SEMIONT_API_URL),
  token$: new BehaviorSubject<typeof token | null>(token),
});
const semiont = new SemiontClient(transport, new HttpContentTransport(transport));

const server = new Server(
  { name: 'semiont-mcp', version: '0.2.0' },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ── Browse ────────────────────────────────────────────────────────
    {
      name: 'browse_resource',
      description: 'Get a resource by ID with its annotations and references',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Resource ID' } }, required: ['id'] },
    },
    {
      name: 'browse_resources',
      description: 'List resources with optional filters',
      inputSchema: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Search query' },
          archived: { type: 'boolean', description: 'Filter by archived status (default: false)' },
          limit: { type: 'number', description: 'Maximum results (default: 20)' },
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
      description: 'Create an annotation (highlight, comment, reference, tag) on a resource',
      inputSchema: {
        type: 'object',
        properties: {
          resourceId: { type: 'string', description: 'Resource ID' },
          selectionData: { type: 'object', description: 'Selection data (offset, length, text)', properties: { offset: { type: 'number' }, length: { type: 'number' }, text: { type: 'string' } } },
          entityTypes: { type: 'array', items: { type: 'string' }, description: 'Entity types for this annotation' },
        },
        required: ['resourceId', 'selectionData'],
      },
    },
    {
      name: 'mark_assist',
      description: 'AI-assisted annotation: detect entities, highlights, assessments, comments, or tags',
      inputSchema: {
        type: 'object',
        properties: {
          resourceId: { type: 'string', description: 'Resource ID' },
          entityTypes: { type: 'array', items: { type: 'string' }, description: 'Entity types to detect (for linking motivation)' },
        },
        required: ['resourceId'],
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
          title: { type: 'string' },
          storageUri: { type: 'string' },
          prompt: { type: 'string', description: 'AI generation prompt' },
          language: { type: 'string' },
        },
        required: ['resourceId', 'annotationId', 'storageUri'],
      },
    },
  ],
}));

server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'browse_resource':       return await handlers.browseResource(semiont, args);
      case 'browse_resources':      return await handlers.browseResources(semiont, args);
      case 'browse_highlights':     return await handlers.browseHighlights(semiont, args);
      case 'browse_references':     return await handlers.browseReferences(semiont, args);
      case 'mark_annotation':       return await handlers.markAnnotation(semiont, args);
      case 'mark_assist':           return await handlers.markAssist(semiont, args);
      case 'bind_body':             return await handlers.bindBody(semiont, args);
      case 'gather_annotation':     return await handlers.gatherAnnotation(semiont, args);
      case 'yield_resource':        return await handlers.yieldResource(semiont, args);
      case 'yield_from_annotation': return await handlers.yieldFromAnnotation(semiont, args);
      default: throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
      isError: true,
    };
  }
});

async function main() {
  console.error('[MCP] Starting semiont-mcp v0.2.0');
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[MCP] Connected');

  process.on('SIGINT', async () => { await server.close(); process.exit(0); });
  process.on('SIGTERM', async () => { await server.close(); process.exit(0); });

  await new Promise(() => {});
}

main().catch((error) => {
  console.error('[MCP] Fatal:', error);
  process.exit(1);
});
