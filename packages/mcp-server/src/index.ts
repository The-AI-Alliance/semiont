#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListPromptsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { SemiontApiClient, baseUrl, accessToken } from '@semiont/api-client';

/**
 * Semiont MCP Server
 *
 * This MCP server provides access to the Semiont API.
 * It handles authentication and makes the API available to AI applications.
 */

import * as handlers from './handlers.js';

// Configuration from environment variables
if (!process.env.SEMIONT_ENV) {
  throw new Error('SEMIONT_ENV environment variable is required');
}
if (!process.env.SEMIONT_API_URL) {
  throw new Error('SEMIONT_API_URL environment variable is required');
}
if (!process.env.SEMIONT_ACCESS_TOKEN) {
  throw new Error('SEMIONT_ACCESS_TOKEN environment variable is required');
}

const SEMIONT_ENV = process.env.SEMIONT_ENV;
const SEMIONT_API_URL = process.env.SEMIONT_API_URL;
const SEMIONT_ACCESS_TOKEN = process.env.SEMIONT_ACCESS_TOKEN;

// Create the stateless Semiont API client
// Auth token is stored separately and passed per-request
const apiClient = new SemiontApiClient({
  baseUrl: baseUrl(SEMIONT_API_URL),
});

// Store the access token to pass with each request
const auth = accessToken(SEMIONT_ACCESS_TOKEN);

// Create the MCP server
const server = new Server(
  {
    name: 'semiont-mcp',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
    },
  }
);

// Define all available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      // Resource Management
      {
        name: 'semiont_create_resource',
        description: 'Create a new resource in the knowledge graph',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Resource name' },
            content: { type: 'string', description: 'Resource content' },
            entityTypes: { 
              type: 'array', 
              items: { type: 'string' },
              description: 'Entity types (e.g., Person, Topic, Concept)' 
            },
            contentType: { type: 'string', description: 'Content MIME type (default: text/plain)' },
            metadata: { type: 'object', description: 'Additional metadata' },
          },
          required: ['name', 'content'],
        },
      },
      {
        name: 'semiont_get_resource',
        description: 'Get a resource by ID with its selections',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Resource ID' },
          },
          required: ['id'],
        },
      },
      {
        name: 'semiont_list_resources',
        description: 'List and search resources',
        inputSchema: {
          type: 'object',
          properties: {
            entityTypes: { type: 'string', description: 'Comma-separated entity types to filter' },
            search: { type: 'string', description: 'Search query' },
            archived: { type: 'boolean', description: 'Filter by archived status (default: false - shows only non-archived resources)' },
            limit: { type: 'number', description: 'Maximum results (default: 20)' },
            offset: { type: 'number', description: 'Offset for pagination (default: 0)' },
          },
        },
      },
      {
        name: 'semiont_detect_selections',
        description: 'Detect selections (entities, references) in a resource',
        inputSchema: {
          type: 'object',
          properties: {
            resourceId: { type: 'string', description: 'Resource ID' },
            types: { 
              type: 'array',
              items: { type: 'string' },
              description: 'Types to detect (default: entities, concepts)' 
            },
            confidence: { type: 'number', description: 'Minimum confidence (0-1, default: 0.7)' },
          },
          required: ['resourceId'],
        },
      },
      // Selection Management
      {
        name: 'semiont_create_selection',
        description: 'Create a new selection in a resource',
        inputSchema: {
          type: 'object',
          properties: {
            resourceId: { type: 'string', description: 'Resource ID' },
            selectionType: { type: 'string', description: 'Selection type (e.g., text_span)' },
            selectionData: { 
              type: 'object',
              description: 'Selection data (offset, length, text, etc.)',
              properties: {
                type: { type: 'string' },
                offset: { type: 'number' },
                length: { type: 'number' },
                text: { type: 'string' },
              },
            },
            entityTypes: { 
              type: 'array',
              items: { type: 'string' },
              description: 'Entity types for this selection' 
            },
            provisional: { type: 'boolean', description: 'Is this provisional?' },
          },
          required: ['resourceId', 'selectionType', 'selectionData'],
        },
      },
      {
        name: 'semiont_save_selection',
        description: 'Save a selection as a highlight',
        inputSchema: {
          type: 'object',
          properties: {
            selectionId: { type: 'string', description: 'Selection ID' },
            metadata: { type: 'object', description: 'Additional metadata' },
          },
          required: ['selectionId'],
        },
      },
      {
        name: 'semiont_resolve_selection',
        description: 'Link a selection to a resource (adds SpecificResource to annotation body)',
        inputSchema: {
          type: 'object',
          properties: {
            selectionId: { type: 'string', description: 'Selection ID' },
            resourceId: { type: 'string', description: 'Target resource ID to link to' },
          },
          required: ['selectionId', 'resourceId'],
        },
      },
      // Resource Generation from Selections
      {
        name: 'semiont_generate_resource_from_selection',
        description: 'Generate a resource with AI-generated content from a selection',
        inputSchema: {
          type: 'object',
          properties: {
            selectionId: { type: 'string', description: 'Selection ID' },
            name: { type: 'string', description: 'Resource name (optional)' },
            entityTypes: { 
              type: 'array',
              items: { type: 'string' },
              description: 'Entity types for the new resource' 
            },
            prompt: { type: 'string', description: 'AI generation prompt' },
          },
          required: ['selectionId'],
        },
      },
      // Context and Analysis
      {
        name: 'semiont_get_contextual_summary',
        description: 'Get a contextual summary for a selection',
        inputSchema: {
          type: 'object',
          properties: {
            selectionId: { type: 'string', description: 'Selection ID' },
            includeRelated: { type: 'boolean', description: 'Include related resources' },
            maxRelated: { type: 'number', description: 'Max related resources' },
          },
          required: ['selectionId'],
        },
      },
      {
        name: 'semiont_get_schema_description',
        description: 'Get a natural language description of the graph schema',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'semiont_get_llm_context',
        description: 'Get LLM-suitable context for a resource and optional selection',
        inputSchema: {
          type: 'object',
          properties: {
            resourceId: { type: 'string', description: 'Resource ID' },
            selectionId: { type: 'string', description: 'Optional selection ID' },
            includeReferences: { type: 'boolean', description: 'Include references (default: true)' },
            includeSelections: { type: 'boolean', description: 'Include selections (default: true)' },
            maxReferencedResources: { type: 'number', description: 'Max referenced docs (default: 5)' },
            contextWindow: { type: 'number', description: 'Context window size (default: 1000)' },
          },
          required: ['resourceId'],
        },
      },
      // Relationship Queries
      {
        name: 'semiont_get_resource_selections',
        description: 'Get all selections in a resource',
        inputSchema: {
          type: 'object',
          properties: {
            resourceId: { type: 'string', description: 'Resource ID' },
          },
          required: ['resourceId'],
        },
      },
      {
        name: 'semiont_get_resource_highlights',
        description: 'Get saved highlights in a resource',
        inputSchema: {
          type: 'object',
          properties: {
            resourceId: { type: 'string', description: 'Resource ID' },
          },
          required: ['resourceId'],
        },
      },
      {
        name: 'semiont_get_resource_references',
        description: 'Get linked references in a resource',
        inputSchema: {
          type: 'object',
          properties: {
            resourceId: { type: 'string', description: 'Resource ID' },
          },
          required: ['resourceId'],
        },
      },
    ],
  };
});

// Handle resources list (empty - we don't provide resources)
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [],
  };
});

// Handle prompts list (empty - we don't provide prompts)
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return {
    prompts: [],
  };
});


// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'semiont_create_resource':
        return await handlers.handleCreateResource(apiClient, auth, args);

      case 'semiont_get_resource':
        return await handlers.handleGetResource(apiClient, auth, args?.id as string);

      case 'semiont_list_resources':
        return await handlers.handleListResources(apiClient, auth, args);

      case 'semiont_detect_selections':
        return await handlers.handleDetectAnnotations(apiClient, auth, args);

      case 'semiont_create_selection':
        return await handlers.handleCreateAnnotation(apiClient, auth, args);

      case 'semiont_save_selection':
        return await handlers.handleSaveAnnotation(apiClient, auth, args);

      case 'semiont_resolve_selection':
        return await handlers.handleResolveAnnotation(apiClient, auth, args);

      case 'semiont_generate_resource_from_selection':
        return await handlers.handleGenerateResourceFromAnnotation(apiClient, auth, args);

      case 'semiont_get_contextual_summary':
        return await handlers.handleGetContextualSummary(apiClient, auth, args);

      case 'semiont_get_schema_description':
        return await handlers.handleGetSchemaDescription(apiClient, auth);

      case 'semiont_get_llm_context':
        return await handlers.handleGetLLMContext(apiClient, auth, args);

      case 'semiont_get_resource_selections':
        return await handlers.handleGetResourceAnnotations(apiClient, auth, args);

      case 'semiont_get_resource_highlights':
        return await handlers.handleGetResourceHighlights(apiClient, auth, args || {});

      case 'semiont_get_resource_references':
        return await handlers.handleGetResourceReferences(apiClient, auth, args || {});

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Error calling Semiont API: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
});

// Start the server
async function main() {
  console.error('[MCP Server] Starting up...');
  console.error('[MCP Server] Environment:', {
    SEMIONT_ENV,
    SEMIONT_API_URL,
    NODE_ENV: process.env.NODE_ENV,
    cwd: process.cwd()
  });

  const transport = new StdioServerTransport();
  console.error('[MCP Server] Connecting to transport...');

  await server.connect(transport);
  console.error('[MCP Server] Connected successfully');

  // Keep the server alive until it receives a termination signal
  process.on('SIGINT', async () => {
    console.error('[MCP Server] Received SIGINT, shutting down...');
    await server.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.error('[MCP Server] Received SIGTERM, shutting down...');
    await server.close();
    process.exit(0);
  });

  // Add handler for unexpected exits
  process.on('exit', (code) => {
    console.error(`[MCP Server] Process exiting with code ${code}`);
  });

  process.on('uncaughtException', (error) => {
    console.error('[MCP Server] Uncaught exception:', error);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('[MCP Server] Unhandled rejection at:', promise, 'reason:', reason);
    process.exit(1);
  });

  console.error('[MCP Server] Setting up keep-alive...');

  // Keep the process alive
  // The server will handle incoming messages via the transport
  await new Promise(() => {
    console.error('[MCP Server] Keep-alive promise created, server should stay running...');

    // Log periodic heartbeat to show we're still alive
    setInterval(() => {
      console.error(`[MCP Server] Still alive at ${new Date().toISOString()}`);
    }, 30000); // Every 30 seconds
  });
}

main().catch((error) => {
  console.error('[MCP Server] Fatal error in main:', error);
  process.exit(1);
});