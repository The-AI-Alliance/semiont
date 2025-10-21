#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListPromptsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { SemiontApiClient } from '@semiont/api-client';

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

// Create the Semiont API client
const apiClient = new SemiontApiClient({
  baseUrl: SEMIONT_API_URL,
  accessToken: SEMIONT_ACCESS_TOKEN,
});

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
      // Document Management
      {
        name: 'semiont_create_document',
        description: 'Create a new document in the knowledge graph',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Document name' },
            content: { type: 'string', description: 'Document content' },
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
        name: 'semiont_get_document',
        description: 'Get a document by ID with its selections',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Document ID' },
          },
          required: ['id'],
        },
      },
      {
        name: 'semiont_list_documents',
        description: 'List and search documents',
        inputSchema: {
          type: 'object',
          properties: {
            entityTypes: { type: 'string', description: 'Comma-separated entity types to filter' },
            search: { type: 'string', description: 'Search query' },
            archived: { type: 'boolean', description: 'Filter by archived status (default: false - shows only non-archived documents)' },
            limit: { type: 'number', description: 'Maximum results (default: 20)' },
            offset: { type: 'number', description: 'Offset for pagination (default: 0)' },
          },
        },
      },
      {
        name: 'semiont_detect_selections',
        description: 'Detect selections (entities, references) in a document',
        inputSchema: {
          type: 'object',
          properties: {
            documentId: { type: 'string', description: 'Document ID' },
            types: { 
              type: 'array',
              items: { type: 'string' },
              description: 'Types to detect (default: entities, concepts)' 
            },
            confidence: { type: 'number', description: 'Minimum confidence (0-1, default: 0.7)' },
          },
          required: ['documentId'],
        },
      },
      // Selection Management
      {
        name: 'semiont_create_selection',
        description: 'Create a new selection in a document',
        inputSchema: {
          type: 'object',
          properties: {
            documentId: { type: 'string', description: 'Document ID' },
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
          required: ['documentId', 'selectionType', 'selectionData'],
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
        description: 'Resolve a selection to a document',
        inputSchema: {
          type: 'object',
          properties: {
            selectionId: { type: 'string', description: 'Selection ID' },
            documentId: { type: 'string', description: 'Target document ID' },
          },
          required: ['selectionId', 'documentId'],
        },
      },
      // Document Generation from Selections
      {
        name: 'semiont_create_document_from_selection',
        description: 'Create a new document from a selection and resolve the selection to it',
        inputSchema: {
          type: 'object',
          properties: {
            selectionId: { type: 'string', description: 'Selection ID' },
            name: { type: 'string', description: 'Document name' },
            content: { type: 'string', description: 'Document content' },
            entityTypes: { 
              type: 'array',
              items: { type: 'string' },
              description: 'Entity types for the new document' 
            },
            contentType: { type: 'string', description: 'Content type (default: text/plain)' },
            metadata: { type: 'object', description: 'Additional metadata' },
          },
          required: ['selectionId', 'name'],
        },
      },
      {
        name: 'semiont_generate_document_from_selection',
        description: 'Generate a document with AI-generated content from a selection',
        inputSchema: {
          type: 'object',
          properties: {
            selectionId: { type: 'string', description: 'Selection ID' },
            name: { type: 'string', description: 'Document name (optional)' },
            entityTypes: { 
              type: 'array',
              items: { type: 'string' },
              description: 'Entity types for the new document' 
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
            includeRelated: { type: 'boolean', description: 'Include related documents' },
            maxRelated: { type: 'number', description: 'Max related documents' },
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
        description: 'Get LLM-suitable context for a document and optional selection',
        inputSchema: {
          type: 'object',
          properties: {
            documentId: { type: 'string', description: 'Document ID' },
            selectionId: { type: 'string', description: 'Optional selection ID' },
            includeReferences: { type: 'boolean', description: 'Include references (default: true)' },
            includeSelections: { type: 'boolean', description: 'Include selections (default: true)' },
            maxReferencedDocuments: { type: 'number', description: 'Max referenced docs (default: 5)' },
            contextWindow: { type: 'number', description: 'Context window size (default: 1000)' },
          },
          required: ['documentId'],
        },
      },
      {
        name: 'semiont_discover_context',
        description: 'Discover relevant context from the graph for a text block',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Text to analyze' },
            maxResults: { type: 'number', description: 'Max results (default: 10)' },
            includeSelections: { type: 'boolean', description: 'Include selections (default: true)' },
            entityTypeFilter: { 
              type: 'array',
              items: { type: 'string' },
              description: 'Filter by entity types' 
            },
            confidenceThreshold: { type: 'number', description: 'Min confidence (0-1, default: 0.5)' },
          },
          required: ['text'],
        },
      },
      // Relationship Queries
      {
        name: 'semiont_get_document_selections',
        description: 'Get all selections in a document',
        inputSchema: {
          type: 'object',
          properties: {
            documentId: { type: 'string', description: 'Document ID' },
          },
          required: ['documentId'],
        },
      },
      {
        name: 'semiont_get_document_highlights',
        description: 'Get saved highlights in a document',
        inputSchema: {
          type: 'object',
          properties: {
            documentId: { type: 'string', description: 'Document ID' },
          },
          required: ['documentId'],
        },
      },
      {
        name: 'semiont_get_document_references',
        description: 'Get resolved references in a document',
        inputSchema: {
          type: 'object',
          properties: {
            documentId: { type: 'string', description: 'Document ID' },
          },
          required: ['documentId'],
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
      case 'semiont_create_document':
        return await handlers.handleCreateDocument(apiClient, args);

      case 'semiont_get_document':
        return await handlers.handleGetDocument(apiClient, args?.id as string);

      case 'semiont_list_documents':
        return await handlers.handleListDocuments(apiClient, args);

      case 'semiont_detect_selections':
        return await handlers.handleDetectAnnotations(apiClient, args);

      case 'semiont_create_selection':
        return await handlers.handleCreateAnnotation(apiClient, args);

      case 'semiont_save_selection':
        return await handlers.handleSaveAnnotation(apiClient, args);

      case 'semiont_resolve_selection':
        return await handlers.handleResolveAnnotation(apiClient, args);

      case 'semiont_create_document_from_selection':
        return await handlers.handleCreateDocumentFromAnnotation(apiClient, args);

      case 'semiont_generate_document_from_selection':
        return await handlers.handleGenerateDocumentFromAnnotation(apiClient, args);

      case 'semiont_get_contextual_summary':
        return await handlers.handleGetContextualSummary(apiClient, args);

      case 'semiont_get_schema_description':
        return await handlers.handleGetSchemaDescription(apiClient);

      case 'semiont_get_llm_context':
        return await handlers.handleGetLLMContext(apiClient, args);

      case 'semiont_discover_context':
        return await handlers.handleDiscoverContext(apiClient, args);

      case 'semiont_get_document_selections':
        return await handlers.handleGetDocumentAnnotations(apiClient, args);

      case 'semiont_get_document_highlights':
        return await handlers.handleGetDocumentHighlights(apiClient, args || {});

      case 'semiont_get_document_references':
        return await handlers.handleGetDocumentReferences(apiClient, args || {});

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