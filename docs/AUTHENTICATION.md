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
graph TD
    subgraph "Browser"
        User[User Login]
        Session[Session Cookie]
    end

    subgraph "Frontend - Next.js"
        NextAuth[NextAuth.js]
        Pages[Protected Pages]
    end

    subgraph "OAuth Provider"
        Google[Google OAuth 2.0]
    end

    subgraph "Backend - Hono"
        JWT[JWT Validator]
        API[Protected APIs]
        TokenGen[Token Generator]
    end

    subgraph "Database"
        Users[(Users Table)]
    end

    User -->|1. Login| NextAuth
    NextAuth -->|2. OAuth Flow| Google
    Google -->|3. User Info| NextAuth
    NextAuth -->|4. Create Session| Session
    NextAuth -->|5. Store User| Users

    Pages -->|6. API Request + JWT| JWT
    JWT -->|7. Validate| API
    API -->|8. Response| Pages

    subgraph "MCP Client Flow"
        MCP[MCP Client]
        MCP -->|Browser Auth| NextAuth
        NextAuth -->|Get Token| TokenGen
        TokenGen -->|Refresh Token| MCP
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

```
1. User Login (Frontend)
   ↓
2. Google OAuth 2.0
   ↓
3. Backend validates OAuth token
   ↓
4. Backend issues JWT token
   ↓
5. Frontend includes JWT in API requests
   ↓
6. Backend validates JWT on each request
```

## Endpoint Protection

### Public Endpoints

Only these endpoints are accessible without authentication:

- `GET /api/health` - Health check for monitoring
- `GET /api` - API documentation
- `POST /api/auth/google` - OAuth login initiation

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
  "sub": "user-123",
  "email": "user@example.com",
  "isAdmin": false,
  "iat": 1698765432,
  "exp": 1699370232
}
```

**Refresh Token Payload**:
```json
{
  "sub": "user-123",
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
import { verify } from 'jsonwebtoken';

export const authMiddleware = async (c, next) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const payload = verify(token, process.env.JWT_SECRET);

    // Attach user to context
    c.set('user', payload);

    await next();
  } catch (error) {
    return c.json({ error: 'Invalid token' }, 401);
  }
};
```

### Route Protection

**Applying Middleware** (`apps/backend/src/routes/documents.ts`):
```typescript
import { authMiddleware } from '../middleware/auth';

// Protected route
app.get('/api/documents', authMiddleware, async (c) => {
  const user = c.get('user');
  // user.sub, user.email, user.isAdmin available

  const documents = await getDocumentsForUser(user.sub);
  return c.json(documents);
});

// Admin-only route
app.delete('/api/documents/:id', authMiddleware, async (c) => {
  const user = c.get('user');

  if (!user.isAdmin) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  await deleteDocument(c.req.param('id'));
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
- [Database Management](./DATABASE.md) - User table schema and Prisma setup

---

**Document Version**: 1.0
**Last Updated**: 2025-10-23
**Authentication**: OAuth 2.0 + JWT with MCP support
