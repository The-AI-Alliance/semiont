# Authentication Architecture

Semiont implements a **secure-by-default** authentication model using OAuth 2.0 and JWT tokens with special support for MCP (Model Context Protocol) clients.

**Related Documentation:**
- [Architecture Overview](./ARCHITECTURE.md) - Overall application architecture
- [AWS Deployment](./platforms/AWS.md) - AWS Secrets Manager configuration
- [Configuration Guide](./CONFIGURATION.md) - Environment and secret management

## Overview

The authentication system has three main components:

1. **Frontend Authentication**: NextAuth.js with Google OAuth 2.0
2. **Backend Authentication**: JWT token validation with secure-by-default API protection
3. **MCP Client Support**: Browser-based OAuth flow with long-lived refresh tokens

## Authentication Flow Diagram

```mermaid
graph TB
    subgraph "Browser"
        User[User]
        Session[Session Cookie<br/>with JWT]
    end

    subgraph "Frontend Server"
        NextAuth[NextAuth.js<br/>OAuth Handler]
    end

    subgraph "OAuth Provider"
        Google[Google OAuth 2.0]
    end

    subgraph "Backend API"
        TokenGen[Token Generator]
        JWT[JWT Validator]
        API[Protected APIs]
    end

    subgraph "Database"
        Users[(Users Table)]
    end

    %% OAuth flow (server-side only)
    User -.->|1. Login| NextAuth
    NextAuth -.->|2. OAuth Flow| Google
    Google -.->|3. OAuth Token| NextAuth
    NextAuth -.->|4. Exchange Token| TokenGen
    TokenGen -.->|5. JWT| NextAuth
    TokenGen -.->|6. Create/Update User| Users
    NextAuth -.->|7. Store JWT| Session

    %% API calls (client-side from browser)
    User -->|8. API Request + JWT| JWT
    JWT -->|9. Validate| API
    API -->|10. Response| User

    subgraph "MCP Client Flow"
        MCP[MCP Client]
        MCP -.->|Browser Auth| NextAuth
        NextAuth -.->|Generate Refresh Token| TokenGen
        TokenGen -.->|30-day Refresh Token| MCP
    end
```

## Authentication Model

### Core Principles

- **Default Protection**: All API routes require authentication automatically
- **Explicit Exceptions**: Public endpoints must be explicitly listed
- **JWT Bearer Tokens**: Stateless authentication for API requests
- **OAuth Integration**: Google OAuth 2.0 for user authentication
- **Domain Restrictions**: Email domain-based access control

### Authentication Flow

**OAuth Login** (server-side, happens once):
```
1. Browser → Frontend Server (NextAuth.js) → Google OAuth
2. Google returns OAuth token → Frontend Server
3. Frontend Server → Backend (exchange OAuth token)
4. Backend validates with Google, generates JWT
5. Frontend Server stores JWT in session cookie
```

**API Calls** (client-side, every request):
```
Browser → Backend (with JWT from session) → Validate & Respond
```

**Key Architecture Points**:
- **Frontend Server** only handles OAuth callback (not a proxy for API calls)
- **Browser** calls Backend API directly using `NEXT_PUBLIC_API_URL`
- **JWT token** stored in NextAuth session cookie, included in API requests
- **Backend** is public-facing (accessible from browser)

## Endpoint Protection

### Public Endpoints

Only these endpoints are accessible without authentication:

- `GET /api/health` - Health check for monitoring
- `GET /api` - API documentation
- `POST /api/tokens/google` - Google OAuth authentication
- `POST /api/tokens/password` - Password authentication
- `POST /api/tokens/refresh` - Refresh token exchange

### Protected Endpoints

All other API routes automatically require:

- Valid JWT token in Authorization header
- Token signature verification
- Token expiration validation
- User existence verification

**Example Request**:
```http
GET /api/documents HTTP/1.1
Host: api.semiont.com
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### Admin Endpoints

Admin endpoints require additional authorization:

- Valid JWT token (authentication)
- `isAdmin: true` user attribute (authorization)
- Returns 403 Forbidden for non-admin users

**Example Admin Routes**:
- `DELETE /api/users/:id`
- `POST /api/admin/settings`

## MCP Authentication

Special authentication support for Model Context Protocol (MCP) clients that need programmatic API access.

### Frontend MCP Bridge

The frontend provides `/auth/mcp-setup` endpoint that:

- Handles browser-based OAuth flow for MCP clients
- Uses NextAuth session cookies for authentication
- Calls backend to generate long-lived refresh tokens
- Redirects to MCP client callback with token

**Usage**:
```bash
# MCP client opens browser to:
https://semiont.com/auth/mcp-setup?callback=http://localhost:8080/callback
```

### Backend Token Management

Two endpoints manage MCP tokens:

#### Generate Refresh Token

```http
POST /api/tokens/mcp-generate
Authorization: Bearer <session-token>

Response:
{
  "refreshToken": "...",
  "expiresIn": 2592000  // 30 days
}
```

#### Exchange Refresh Token

```http
POST /api/tokens/refresh
Content-Type: application/json

{
  "refreshToken": "..."
}

Response:
{
  "accessToken": "...",
  "expiresIn": 3600  // 1 hour
}
```

### Token Lifecycle

1. **Initial Setup**: MCP client opens browser to `/auth/mcp-setup?callback=<url>`
2. **User Authentication**: Frontend authenticates user via NextAuth (Google OAuth)
3. **Token Generation**: Frontend calls backend's `/api/tokens/mcp-generate`
4. **Refresh Token Issued**: Backend generates 30-day refresh token
5. **Callback**: Frontend redirects to callback URL with refresh token
6. **Local Storage**: MCP client stores refresh token locally
7. **Token Exchange**: MCP client exchanges refresh token for 1-hour access tokens as needed

**Example MCP Client Usage**:
```typescript
// Initial setup - done once
const refreshToken = await mcpClient.authenticate({
  authUrl: 'https://semiont.com/auth/mcp-setup',
  callbackUrl: 'http://localhost:8080/callback'
});

// Store refresh token
await mcpClient.storeToken(refreshToken);

// Exchange for access token - done hourly
const accessToken = await mcpClient.refreshAccessToken(refreshToken);

// Use access token
const response = await fetch('https://api.semiont.com/api/documents', {
  headers: {
    'Authorization': `Bearer ${accessToken}`
  }
});
```

## JWT Security

### Token Validation Layers

1. **Signature Verification**: Validates token hasn't been tampered with using HMAC SHA256
2. **Payload Structure**: Runtime validation of token structure with Zod schemas
3. **Expiration Checking**: Ensures token hasn't expired (7-day default)
4. **User Verification**: Confirms user exists and is active in database
5. **Domain Validation**: Checks email domain against allowed list

### Security Features

- **Short-lived Access Tokens**: 7-day expiration by default
- **Long-lived Refresh Tokens**: 30-day expiration for MCP clients only
- **Secure Secret Management**: JWT secret stored in secure secret storage
- **Domain Restrictions**: Email domain-based access control
- **Automatic Middleware**: Global authentication applied to all API routes

### Token Structure

**Access Token Payload**:
```json
{
  "userId": "user-123",
  "email": "user@example.com",
  "name": "User Name",
  "domain": "example.com",
  "provider": "google",
  "isAdmin": false,
  "iat": 1698765432,
  "exp": 1699370232
}
```

**Refresh Token Payload**:
```json
{
  "userId": "user-123",
  "email": "user@example.com",
  "domain": "example.com",
  "provider": "google",
  "isAdmin": false,
  "type": "refresh",
  "iat": 1698765432,
  "exp": 1701357432
}
```

## Implementation Details

### Frontend Authentication (NextAuth.js)

**Configuration** (`apps/frontend/src/auth.ts`):
```typescript
import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),
  ],
  callbacks: {
    async signIn({ user, account, profile }) {
      // Domain restriction
      if (!user.email?.endsWith('@allowed-domain.com')) {
        return false;
      }
      return true;
    },
  },
});
```

### Backend Authentication Middleware

**JWT Validation** (`apps/backend/src/middleware/auth.ts`):
```typescript
import { Context, Next } from 'hono';
import { OAuthService } from '../auth/oauth';
import { accessToken } from '@semiont/api-client';

export const authMiddleware = async (c: Context, next: Next): Promise<Response | void> => {
  const logger = c.get('logger');
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn('Authentication failed: Missing Authorization header', {
      type: 'auth_failed',
      reason: 'missing_header',
      path: c.req.path,
      method: c.req.method
    });
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const tokenStr = authHeader.substring(7).trim();

  if (!tokenStr) {
    logger.warn('Authentication failed: Empty token', {
      type: 'auth_failed',
      reason: 'empty_token'
    });
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const user = await OAuthService.getUserFromToken(accessToken(tokenStr));
    c.set('user', user);

    logger.debug('Authentication successful', {
      type: 'auth_success',
      userId: user.id,
      email: user.email
    });

    await next();
  } catch (error) {
    logger.warn('Authentication failed: Invalid token', {
      type: 'auth_failed',
      reason: 'invalid_token',
      error: error instanceof Error ? error.message : String(error)
    });
    return c.json({ error: 'Invalid token' }, 401);
  }
};
```

### Route Protection

**Applying Middleware** (`apps/backend/src/routes/auth.ts`):
```typescript
import { authMiddleware } from '../middleware/auth';
import { Hono } from 'hono';
import type { User } from '@prisma/client';

export const authRouter = new Hono<{ Variables: { user: User } }>();

// Protected route - requires authentication
authRouter.get('/api/users/me', authMiddleware, async (c) => {
  const user = c.get('user');
  // user.id, user.email, user.isAdmin available

  return c.json({
    id: user.id,
    email: user.email,
    name: user.name,
    domain: user.domain,
    provider: user.provider,
    isAdmin: user.isAdmin
  });
});

// Admin-only route
authRouter.patch('/api/admin/users/:id', authMiddleware, async (c) => {
  const user = c.get('user');

  if (!user.isAdmin) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const userId = c.req.param('id');
  // Update user logic here
  return c.json({ success: true });
});
```

## Environment Configuration

### Required Environment Variables

**Frontend** (`.env.local`):
```bash
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=your-nextauth-secret
```

**Backend** (`.env`):
```bash
JWT_SECRET=your-jwt-secret
DATABASE_URL=postgresql://user:pass@localhost:5432/semiont
ALLOWED_EMAIL_DOMAINS=example.com,company.com
```

### Secret Management

For production deployment:
- Store secrets in secure secret storage (e.g., AWS Secrets Manager)
- Never commit secrets to Git
- Use different secrets per environment
- Rotate secrets regularly

See [Configuration Guide](./CONFIGURATION.md) for detailed secret management.

## Security Best Practices

### Token Management

1. **Never store tokens in localStorage**: Use secure httpOnly cookies for web apps
2. **Short expiration times**: Access tokens expire in 7 days, refresh tokens in 30 days
3. **Secure transmission**: Always use HTTPS in production
4. **Token rotation**: Refresh tokens should be rotated on use (future enhancement)

### OAuth Configuration

1. **Restrict redirect URIs**: Only allow known callback URLs
2. **Domain restrictions**: Limit access to specific email domains
3. **Verify email**: Always verify email is confirmed by OAuth provider
4. **Scope minimization**: Only request necessary OAuth scopes

### API Security

1. **Default deny**: All routes protected unless explicitly public
2. **Rate limiting**: Implement rate limiting per IP/user (see [AWS.md](./platforms/AWS.md) for WAF configuration)
3. **Input validation**: Validate all inputs with Zod schemas
4. **Audit logging**: Log all authentication events

## Troubleshooting

### Common Issues

**"Unauthorized" Error**:
- Check Authorization header is present and correctly formatted
- Verify JWT secret matches between token generation and validation
- Ensure token hasn't expired

**OAuth Callback Fails**:
- Verify redirect URI matches Google OAuth configuration
- Check NEXTAUTH_URL environment variable is correct
- Ensure Google Client ID/Secret are valid

**MCP Token Exchange Fails**:
- Refresh token may have expired (30-day limit)
- Verify refresh token is correctly stored and transmitted
- Check backend `/api/tokens/refresh` endpoint is accessible

**Domain Restriction Blocks Login**:
- Verify user email domain is in ALLOWED_EMAIL_DOMAINS
- Check domain comparison logic in signIn callback
- Ensure email is verified by OAuth provider

## Related Documentation

- [Architecture Overview](./ARCHITECTURE.md) - Application architecture and service communication
- [AWS Deployment](./platforms/AWS.md) - AWS Secrets Manager and security groups
- [Configuration Guide](./CONFIGURATION.md) - Environment variables and secret management
- [Database Management](./services/DATABASE.md) - User table schema and Prisma setup

---

**Document Version**: 1.0
**Last Updated**: 2025-10-23
**Authentication**: OAuth 2.0 + JWT with MCP support
