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

// Configuration from environment variables
const SEMIONT_API_URL = process.env.SEMIONT_API_URL || 'http://localhost:4000';
const SEMIONT_API_TOKEN = process.env.SEMIONT_API_TOKEN || '';

// Create the MCP server
const server = new Server(
  {
    name: 'semiont-mcp',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define the hello tool
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
  if (request.params.name === 'semiont_hello') {
    try {
      // Extract the name parameter if provided
      const name = request.params.arguments?.name as string | undefined;
      
      // Build the URL with optional name parameter
      const url = name 
        ? `${SEMIONT_API_URL}/api/hello/${encodeURIComponent(name)}`
        : `${SEMIONT_API_URL}/api/hello`;
      
      // Make the API request with authentication
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${SEMIONT_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
      });
      
      if (!response.ok) {
        // Handle authentication errors specially
        if (response.status === 401) {
          throw new Error('Authentication failed. Please set SEMIONT_API_TOKEN environment variable with a valid JWT token.');
        }
        throw new Error(`API request failed: ${response.status} ${response.statusText}`);
      }
      
      const data = await response.json();
      
      // Return the formatted response
      return {
        content: [
          {
            type: 'text',
            text: `${data.message}\n\nPlatform: ${data.platform}\nTimestamp: ${data.timestamp}${data.user ? `\nAuthenticated as: ${data.user}` : ''}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error calling Semiont API: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
        isError: true,
      };
    }
  }
  
  throw new Error(`Unknown tool: ${request.params.name}`);
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  // Don't output anything to stdout/stderr - it breaks the JSON-RPC protocol
  // The MCP server communicates only via JSON-RPC over stdio
}

main().catch((error) => {
  // Can't log to console - it would break JSON-RPC protocol
  // Just exit with error code
  process.exit(1);
});