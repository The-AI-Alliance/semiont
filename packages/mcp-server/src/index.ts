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
      
      // Get fresh access token
      const token = await getAccessToken();
      
      // Make the API request with authentication
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
      
      if (!response.ok) {
        // Handle authentication errors specially
        if (response.status === 401) {
          // Clear cached token on auth failure
          accessToken = null;
          tokenExpiry = null;
          throw new Error('Authentication failed. Token may have expired. Please re-provision with: semiont provision --service mcp');
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