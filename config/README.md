# Semiont Configuration

This directory contains all configuration for the Semiont platform. Configuration is structured in TypeScript for type safety and validation.

## Quick Start

To deploy Semiont to your own domain/AWS account:

1. Copy `config/base/site.config.ts.example` to `config/base/site.config.ts`
2. Update the values in `site.config.ts` with your settings
3. Run deployment: `npm run deploy`

## Configuration Structure

```
config/
├── base/                 # Base configuration files
│   ├── site.config.ts   # Site-specific settings (domain, branding)
│   ├── aws.config.ts    # AWS infrastructure settings
│   └── app.config.ts    # Application settings
├── environments/        # Environment-specific overrides
├── schemas/            # TypeScript types and validation
└── index.ts           # Main configuration export
```

## Configuration Precedence

1. Environment variables (highest priority)
2. Environment-specific config files
3. Base configuration files
4. Default values

## Production vs Development URLs

**Important**: The application config URLs (`backend.url`, `frontend.url`) are used for **development and testing only**.

### Development & Test
- Uses `localhost` URLs from config files
- Direct service-to-service communication
- Example: `http://localhost:3001` (backend), `http://localhost:3000` (frontend)

### Production
- **CDK infrastructure manages all URLs** - no need for backend/frontend URLs in config
- Everything runs behind a single domain with Load Balancer routing
- CDK sets runtime environment variables: `NEXT_PUBLIC_API_URL`, `FRONTEND_URL`, etc.
- Example: `https://wiki.example.com` with ALB routing `/api/*` to backend, everything else to frontend

This separation keeps infrastructure concerns (CDK) separate from application concerns (config).

## URL Configuration Examples

```typescript
// Development config (config/environments/development.ts)
app: {
  backend: { url: 'http://localhost:4000' },
  frontend: { url: 'http://localhost:3000' }
}

// Production config (config/environments/production.ts)
// No backend/frontend URLs needed - CDK handles this via:
// - config.site.domain → Load Balancer domain
// - Environment variables set by CDK at runtime
```

## Type Safety

All configuration is strongly typed using TypeScript interfaces. Runtime validation ensures configuration integrity.

## URL Objects

Configuration uses native URL objects for type safety and flexibility:

```typescript
const backendUrl = getBackendUrlObject();
console.log(backendUrl.hostname);  // 'localhost'
console.log(backendUrl.port);      // '3001'  
console.log(backendUrl.origin);    // 'http://localhost:3001'
```

## Sensitive Data

Never commit sensitive data like API keys or secrets. Use:
- Environment variables for local development
- AWS Secrets Manager for production
- `.env.local` files (gitignored) for local overrides