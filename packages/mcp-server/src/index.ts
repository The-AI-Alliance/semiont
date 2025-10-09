#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListPromptsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * Semiont MCP Server
 * 
 * This MCP server provides access to the Semiont API hello endpoint.
 * It handles authentication and makes the API available to AI applications.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import fetch from 'node-fetch';

// Configuration from environment variables
const SEMIONT_ENV = process.env.SEMIONT_ENV || 'development';
const SEMIONT_API_URL = process.env.SEMIONT_API_URL || 'http://localhost:4000';

// Token management
let accessToken: string | null = null;
let tokenExpiry: Date | null = null;

async function getAccessToken(): Promise<string> {
  // Check if we have a valid cached token
  if (accessToken && tokenExpiry && tokenExpiry > new Date()) {
    return accessToken;
  }
  
  // Read the refresh token from provisioned auth file
  const authPath = path.join(os.homedir(), '.config', 'semiont', `mcp-auth-${SEMIONT_ENV}.json`);
  
  if (!fs.existsSync(authPath)) {
    throw new Error(`MCP not provisioned for ${SEMIONT_ENV}. Run: semiont provision --service mcp --environment ${SEMIONT_ENV}`);
  }
  
  const authData = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
  
  // Exchange refresh token for access token
  const response = await fetch(`${SEMIONT_API_URL}/api/tokens/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: authData.refresh_token })
  });
  
  if (!response.ok) {
    throw new Error(`Failed to refresh token: ${response.statusText}`);
  }
  
  const data = await response.json() as { access_token: string };
  accessToken = data.access_token;
  
  // Set expiry to 55 minutes from now (tokens typically last 1 hour)
  tokenExpiry = new Date(Date.now() + 55 * 60 * 1000);
  
  return accessToken;
}

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
      {
        name: 'semiont_hello',
        description: 'Get a personalized greeting from Semiont. Returns a welcome message with optional personalization.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Optional name for personalized greeting (max 100 characters)',
            },
          },
        },
      },
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

// Helper function to make authenticated API calls
async function callSemiontAPI(
  path: string,
  method: string = 'GET',
  body?: any
): Promise<any> {
  const token = await getAccessToken();
  
  const options: RequestInit = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  
  if (body && method !== 'GET') {
    options.body = JSON.stringify(body);
  }
  
  const response = await fetch(`${SEMIONT_API_URL}${path}`, options);
  
  if (!response.ok) {
    if (response.status === 401) {
      accessToken = null;
      tokenExpiry = null;
      throw new Error('Authentication failed. Token may have expired. Please re-provision with: semiont provision --service mcp');
    }
    throw new Error(`API request failed: ${response.status} ${response.statusText}`);
  }
  
  return response.json();
}

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  try {
    switch (name) {
      case 'semiont_hello': {
        const nameParam = args?.name as string | undefined;
        const url = nameParam ? `/api/hello/${encodeURIComponent(nameParam)}` : '/api/hello';
        const data = await callSemiontAPI(url);
        return {
          content: [{
            type: 'text',
            text: `${data.message}\n\nPlatform: ${data.platform}\nTimestamp: ${data.timestamp}${data.user ? `\nAuthenticated as: ${data.user}` : ''}`,
          }],
        };
      }
      
      // Document Management
      case 'semiont_create_document': {
        const data = await callSemiontAPI('/api/documents', 'POST', {
          name: args?.name,
          content: args?.content,
          entityTypes: args?.entityTypes || [],
          contentType: args?.contentType || 'text/plain',
          metadata: args?.metadata || {},
        });
        return {
          content: [{
            type: 'text',
            text: `Document created successfully:\nID: ${data.document.id}\nName: ${data.document.name}\nEntity Types: ${data.document.entityTypes?.join(', ') || 'None'}`,
          }],
        };
      }
      
      case 'semiont_get_document': {
        const data = await callSemiontAPI(`/api/documents/${args?.id}`);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(data, null, 2),
          }],
        };
      }
      
      case 'semiont_list_documents': {
        const params = new URLSearchParams();
        if (args?.entityTypes) params.set('entityTypes', args.entityTypes as string);
        if (args?.search) params.set('search', args.search as string);
        // Default to archived: false (show only non-archived documents)
        const archived = args?.archived ?? false;
        params.set('archived', String(archived));
        if (args?.limit) params.set('limit', args.limit.toString());
        if (args?.offset) params.set('offset', args.offset.toString());

        const data = await callSemiontAPI(`/api/documents?${params}`);
        return {
          content: [{
            type: 'text',
            text: `Found ${data.total} documents:\n${data.documents.map((d: any) => `- ${d.name} (${d.id}) - ${d.entityTypes?.join(', ') || 'No types'}`).join('\n')}`,
          }],
        };
      }
      
      case 'semiont_detect_selections': {
        const data = await callSemiontAPI(`/api/documents/${args?.documentId}/detect-selections`, 'POST', {
          types: args?.types || ['entities', 'concepts'],
          confidence: args?.confidence || 0.7,
        });
        return {
          content: [{
            type: 'text',
            text: `Detected ${data.selections.length} selections:\n${data.selections.map((s: any) => `- ${s.selection.selectionData.text} (${s.selection.selectionType}) - Confidence: ${s.selection.confidence}`).join('\n')}`,
          }],
        };
      }
      
      // Selection Management
      case 'semiont_create_selection': {
        const data = await callSemiontAPI('/api/annotations', 'POST', {
          documentId: args?.documentId,
          selectionType: args?.selectionType,
          selectionData: args?.selectionData,
          entityTypes: args?.entityTypes,
          provisional: args?.provisional,
        });
        return {
          content: [{
            type: 'text',
            text: `Selection created:\nID: ${data.id}\nType: ${data.selectionType}\nText: ${data.selectionData?.text || 'N/A'}`,
          }],
        };
      }
      
      case 'semiont_save_selection': {
        const data = await callSemiontAPI(`/api/annotations/${args?.selectionId}/save`, 'PUT', {
          metadata: args?.metadata,
        });
        return {
          content: [{
            type: 'text',
            text: `Selection saved as highlight:\nID: ${data.id}\nSaved: ${data.saved}`,
          }],
        };
      }
      
      case 'semiont_resolve_selection': {
        const data = await callSemiontAPI(`/api/annotations/${args?.selectionId}/resolve`, 'PUT', {
          documentId: args?.documentId,
        });
        return {
          content: [{
            type: 'text',
            text: `Selection resolved to document:\nSelection ID: ${data.id}\nResolved to: ${data.resolvedDocumentId}`,
          }],
        };
      }
      
      // Document Generation
      case 'semiont_create_document_from_selection': {
        const data = await callSemiontAPI(`/api/annotations/${args?.selectionId}/create-document`, 'POST', {
          name: args?.name,
          content: args?.content || '',
          entityTypes: args?.entityTypes,
          contentType: args?.contentType || 'text/plain',
          metadata: args?.metadata,
        });
        return {
          content: [{
            type: 'text',
            text: `Document created from selection:\nDocument ID: ${data.document.id}\nDocument Name: ${data.document.name}\nSelection resolved: ${data.selection.resolvedDocumentId === data.document.id}`,
          }],
        };
      }
      
      case 'semiont_generate_document_from_selection': {
        const data = await callSemiontAPI(`/api/annotations/${args?.selectionId}/generate-document`, 'POST', {
          name: args?.name,
          entityTypes: args?.entityTypes,
          prompt: args?.prompt,
        });
        return {
          content: [{
            type: 'text',
            text: `Document generated from selection:\nDocument ID: ${data.document.id}\nDocument Name: ${data.document.name}\nGenerated: ${data.generated}\nContent Preview: ${data.document.content?.substring(0, 200)}...`,
          }],
        };
      }
      
      // Context and Analysis
      case 'semiont_get_contextual_summary': {
        const data = await callSemiontAPI(`/api/annotations/${args?.selectionId}/contextual-summary`, 'POST', {
          includeRelated: args?.includeRelated,
          maxRelated: args?.maxRelated,
        });
        return {
          content: [{
            type: 'text',
            text: `Contextual Summary:\n${data.summary}\n\nRelevant Fields:\n${JSON.stringify(data.relevantFields, null, 2)}`,
          }],
        };
      }
      
      case 'semiont_get_schema_description': {
        const data = await callSemiontAPI('/api/documents/schema-description');
        return {
          content: [{
            type: 'text',
            text: data.description,
          }],
        };
      }
      
      case 'semiont_get_llm_context': {
        const data = await callSemiontAPI(`/api/documents/${args?.documentId}/llm-context`, 'POST', {
          selectionId: args?.selectionId,
          includeReferences: args?.includeReferences,
          includeSelections: args?.includeSelections,
          maxReferencedDocuments: args?.maxReferencedDocuments,
          contextWindow: args?.contextWindow,
        });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(data, null, 2),
          }],
        };
      }
      
      case 'semiont_discover_context': {
        const data = await callSemiontAPI('/api/documents/discover-context', 'POST', {
          text: args?.text,
          maxResults: args?.maxResults,
          includeSelections: args?.includeSelections,
          entityTypeFilter: args?.entityTypeFilter,
          confidenceThreshold: args?.confidenceThreshold,
        });
        return {
          content: [{
            type: 'text',
            text: `Context Discovery Results:\n\nDetected Entities: ${data.query.detectedEntities.map((e: any) => e.text).join(', ')}\nDetected Topics: ${data.query.detectedTopics.join(', ')}\n\nRelevant Documents: ${data.relevantDocuments.length}\nRelevant Selections: ${data.relevantSelections.length}\nSuggested Connections: ${data.suggestedConnections.length}\n\nDetails:\n${JSON.stringify(data, null, 2)}`,
          }],
        };
      }
      
      // Relationship Queries
      case 'semiont_get_document_selections': {
        const data = await callSemiontAPI(`/api/documents/${args?.documentId}/selections`);
        return {
          content: [{
            type: 'text',
            text: `Found ${data.selections.length} selections in document:\n${data.selections.map((s: any) => `- ${s.selectionData?.text || s.id} (${s.selectionType})`).join('\n')}`,
          }],
        };
      }
      
      case 'semiont_get_document_highlights': {
        const data = await callSemiontAPI(`/api/documents/${args?.documentId}/highlights`);
        return {
          content: [{
            type: 'text',
            text: `Found ${data.highlights.length} highlights in document:\n${data.highlights.map((h: any) => `- ${h.selectionData?.text || h.id} (saved by ${h.savedBy})`).join('\n')}`,
          }],
        };
      }
      
      case 'semiont_get_document_references': {
        const data = await callSemiontAPI(`/api/documents/${args?.documentId}/references`);
        return {
          content: [{
            type: 'text',
            text: `Found ${data.references.length} references in document:\n${data.references.map((r: any) => `- ${r.selectionData?.text || r.id} → ${r.resolvedDocumentId}`).join('\n')}`,
          }],
        };
      }
      
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