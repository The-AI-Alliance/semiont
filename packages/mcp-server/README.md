# Semiont MCP Server

This Model Context Protocol (MCP) server provides AI applications with access to the Semiont API.

## Features

Currently exposes:
- `semiont_hello` - Get a personalized greeting from the Semiont platform

## Installation

```bash
cd packages/mcp-server
npm install
npm run build
```

## Authentication

The MCP server uses JWT tokens for API authentication. There are two types of tokens:
- **Refresh Token**: Long-lived (30 days), used to obtain access tokens
- **Access Token**: Short-lived (1 hour), used for API requests

### Automatic Authentication Setup (Recommended)

The easiest way to authenticate is through the browser-based OAuth flow:

```bash
# Use the CLI to provision MCP with OAuth authentication
semiont provision --service mcp

# This will:
# 1. Open your browser for Google OAuth login
# 2. Generate a 30-day refresh token
# 3. Store it in ~/.config/semiont/mcp-auth-{environment}.json
```

### Manual Configuration

If you need to manually configure authentication:

```bash
# API endpoint (defaults to local development)
export SEMIONT_API_URL=http://localhost:4000

# Refresh token for authentication (30-day validity)
export SEMIONT_REFRESH_TOKEN=your-refresh-token-here
```

### Getting Tokens Manually

1. **Via Browser OAuth Flow**:
   ```bash
   # Open browser to authenticate and get refresh token
   open "http://localhost:3000/api/auth/mcp-setup?callback=http://localhost:8080"
   
   # This will:
   # - Redirect to Google OAuth login
   # - Generate a 30-day refresh token
   # - Redirect to callback with token as query parameter
   ```

2. **Via Frontend Login** (get access token):
   ```bash
   # 1. Start the Semiont platform
   semiont start
   
   # 2. Visit http://localhost:3000 and login with Google
   
   # 3. Open browser DevTools and find the access token in:
   #    - localStorage: 'token' key
   #    - Or Network tab: Authorization header in API requests
   #    Note: This is a 1-hour access token, not a refresh token
   ```

3. **Via Direct API Call** (if you have Google OAuth token):
   ```bash
   curl -X POST http://localhost:4000/api/auth/google \
     -H "Content-Type: application/json" \
     -d '{"access_token": "your-google-oauth-token"}'
   ```

4. **For Testing** (create a test user directly):
   ```bash
   semiont exec --service backend \
     "npx ts-node -e \"
       const { PrismaClient } = require('@prisma/client');
       const jwt = require('jsonwebtoken');
       const prisma = new PrismaClient();
       
       async function createTestUser() {
         const user = await prisma.user.create({
           data: {
             email: 'test@example.com',
             name: 'Test User',
             provider: 'google',
             providerId: 'test-' + Date.now(),
             domain: 'example.com'
           }
         });
         
         const token = jwt.sign(
           { userId: user.id, email: user.email },
           process.env.JWT_SECRET,
           { expiresIn: '7d' }
         );
         
         console.log('Token:', token);
       }
       
       createTestUser();
     \""
   ```

## Usage

### Desktop Apps (Claude Desktop)

1. **Provision MCP authentication**:
   ```bash
   semiont provision --service mcp --environment production
   ```
   This will:
   - Open your browser for OAuth authentication
   - Generate a long-lived refresh token (30 days)
   - Store credentials in `~/.config/semiont/mcp-auth-<env>.json`

2. **Configure Claude Desktop**:
   Add to your Claude Desktop configuration:
   ```json
   {
     "mcpServers": {
       "semiont": {
         "command": "semiont",
         "args": ["start", "--service", "mcp", "--environment", "production"]
       }
     }
   }
   ```

3. **The MCP server will**:
   - Automatically refresh access tokens (1-hour expiry)
   - Provide Semiont API access to Claude
   - Handle authentication transparently

### Programmatic Usage

```javascript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'child_process';

// Start the MCP server
const serverProcess = spawn('node', ['dist/index.js'], {
  env: {
    ...process.env,
    SEMIONT_API_URL: 'https://your-domain.com',
    SEMIONT_API_TOKEN: 'your-access-token' // Note: Use refresh token flow for production
  }
});

// Create MCP client
const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
});

const client = new Client({
  name: 'semiont-client',
  version: '1.0.0',
}, {
  capabilities: {}
});

await client.connect(transport);

// List available tools
const tools = await client.request({
  method: 'tools/list'
});

// Call the hello tool
const result = await client.request({
  method: 'tools/call',
  params: {
    name: 'semiont_hello',
    arguments: {
      name: 'AI Assistant'
    }
  }
});

console.log(result);
```

## Available Tools

### `semiont_hello`

Get a personalized greeting from Semiont.

**Parameters**:
- `name` (optional, string): Name for personalized greeting (max 100 characters)

**Returns**:
- Message with greeting
- Platform information
- Timestamp
- Authenticated user (if token provided)

**Example**:
```json
{
  "name": "semiont_hello",
  "arguments": {
    "name": "John Doe"
  }
}
```

**Response**:
```
Hello, John Doe! Welcome to Semiont.

Platform: Semiont Semantic Knowledge Platform
Timestamp: 2024-01-15T10:30:00.000Z
Authenticated as: user@example.com
```

## Development

```bash
# Install dependencies
npm install

# Run in development mode (with auto-reload)
npm run dev

# Build for production
npm run build

# Run tests (when added)
npm test
```

## Testing the MCP Server

```bash
# Test directly with npx
npx @modelcontextprotocol/inspector \
  node packages/mcp-server/dist/index.js

# This opens a web interface where you can:
# 1. See available tools
# 2. Test calling the semiont_hello tool
# 3. View request/response details
```

## Extending the Server

To add more Semiont API endpoints:

1. Add new tool definitions in `ListToolsRequestSchema` handler
2. Add corresponding execution logic in `CallToolRequestSchema` handler
3. Update this README with the new tools

Example for adding a status endpoint:

```typescript
// In ListToolsRequestSchema handler
{
  name: 'semiont_status',
  description: 'Get Semiont platform status',
  inputSchema: {
    type: 'object',
    properties: {},
  },
}

// In CallToolRequestSchema handler
if (request.params.name === 'semiont_status') {
  const response = await fetch(`${SEMIONT_API_URL}/api/status`, {
    headers: { 'Authorization': `Bearer ${SEMIONT_API_TOKEN}` },
  });
  const data = await response.json();
  return {
    content: [{
      type: 'text',
      text: `Status: ${data.status}\nVersion: ${data.version}`
    }],
  };
}
```

## Token Management

The MCP server automatically handles token refresh:
1. Uses refresh token to get initial access token
2. Monitors access token expiration (1 hour)
3. Automatically refreshes access token before expiration
4. Refresh tokens are valid for 30 days

When a refresh token expires after 30 days, you'll need to re-authenticate:
```bash
semiont provision --service mcp
```

## Troubleshooting

### "Authentication failed"
- Ensure `SEMIONT_REFRESH_TOKEN` is set with a valid refresh token
- Check refresh token hasn't expired (tokens expire after 30 days)
- For expired tokens, run `semiont provision --service mcp` to re-authenticate
- Verify the Semiont backend is running

### "Connection refused"
- Check Semiont platform is running: `semiont check`
- Verify `SEMIONT_API_URL` matches your backend URL
- Ensure backend is accessible from MCP server

### "Unknown tool"
- Tool name must be exactly `semiont_hello`
- Check for typos in the tool name

## Security Notes

- Never commit tokens to version control
- Refresh tokens expire after 30 days and need renewal
- Access tokens expire after 1 hour (automatically refreshed by the server)
- Use environment variables or secure credential storage for tokens
- The MCP server implements automatic token refresh for long-running sessions

## Future Enhancements

Planned additions:
- [ ] Automatic token refresh
- [ ] More Semiont API endpoints
- [ ] Caching for frequently accessed data
- [ ] Rate limiting and retry logic
- [ ] WebSocket support for real-time updates
- [ ] Semantic search capabilities
- [ ] Knowledge graph operations