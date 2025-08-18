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

## Configuration

Set environment variables:

```bash
# API endpoint (defaults to local development)
export SEMIONT_API_URL=http://localhost:4000

# JWT token for authentication (required for protected routes)
export SEMIONT_API_TOKEN=your-jwt-token-here
```

### Getting a JWT Token

1. **Via Frontend Login**:
   ```bash
   # 1. Start the Semiont platform
   semiont start
   
   # 2. Visit http://localhost:3000 and login with Google
   
   # 3. Open browser DevTools and find the token in:
   #    - localStorage: 'token' key
   #    - Or Network tab: Authorization header in API requests
   ```

2. **Via Direct API Call** (if you have Google OAuth token):
   ```bash
   curl -X POST http://localhost:4000/api/auth/google \
     -H "Content-Type: application/json" \
     -d '{"access_token": "your-google-oauth-token"}'
   ```

3. **For Testing** (create a test user directly):
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

### With Claude Desktop

Add to your Claude Desktop configuration (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "semiont": {
      "command": "node",
      "args": ["/path/to/semiont/packages/mcp-server/dist/index.js"],
      "env": {
        "SEMIONT_API_URL": "http://localhost:4000",
        "SEMIONT_API_TOKEN": "your-jwt-token"
      }
    }
  }
}
```

### Programmatic Usage

```javascript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'child_process';

// Start the MCP server
const serverProcess = spawn('node', ['dist/index.js'], {
  env: {
    ...process.env,
    SEMIONT_API_URL: 'http://localhost:4000',
    SEMIONT_API_TOKEN: 'your-token'
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
    "name": "Claude"
  }
}
```

**Response**:
```
Hello, Claude! Welcome to Semiont.

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

## Troubleshooting

### "Authentication failed"
- Ensure `SEMIONT_API_TOKEN` is set with a valid JWT token
- Check token hasn't expired (tokens expire after 7 days)
- Verify the Semiont backend is running

### "Connection refused"
- Check Semiont platform is running: `semiont check`
- Verify `SEMIONT_API_URL` matches your backend URL
- Ensure backend is accessible from MCP server

### "Unknown tool"
- Tool name must be exactly `semiont_hello`
- Check for typos in the tool name

## Security Notes

- Never commit JWT tokens to version control
- Tokens expire after 7 days and need renewal
- Use environment variables or secure credential storage for tokens
- Consider implementing token refresh logic for long-running servers

## Future Enhancements

Planned additions:
- [ ] Automatic token refresh
- [ ] More Semiont API endpoints
- [ ] Caching for frequently accessed data
- [ ] Rate limiting and retry logic
- [ ] WebSocket support for real-time updates
- [ ] Semantic search capabilities
- [ ] Knowledge graph operations