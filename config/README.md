# Semiont Configuration

This directory contains the authoritative JSON configuration files for the Semiont platform. The configuration system separates data (this directory) from the loading logic (packages/config-loader) for better organization and maintainability.

## Quick Start

To deploy Semiont to your own domain/AWS account:

1. Edit `config/environments/development.json` with your development settings
2. Edit `config/environments/production.json` with your production settings  
3. Validate configuration: `../bin/semiont configure validate`
4. Run deployment: `../bin/semiont deploy production`

## Configuration Structure

```
config/                     # Authoritative JSON configuration files
├── environments/          # Environment-specific JSON configurations
│   ├── development.json  # Development environment settings
│   ├── integration.json  # Integration test environment
│   ├── production.json   # Production environment settings
│   ├── test.json         # Base test configuration
│   ├── unit.json         # Unit test configuration
│   └── *.json            # Custom environment configurations
└── README.md             # This file

packages/config-loader/   # Configuration loading and validation library
├── base/                 # Base configuration files
│   ├── site.config.ts   # Site-specific settings (domain, branding)
│   ├── aws.config.ts    # AWS infrastructure settings
│   └── app.config.ts    # Application settings
├── schemas/              # TypeScript types and validation
│   ├── config.schema.ts # Configuration interfaces
│   └── validation.ts    # Runtime validation
└── index.ts             # Main configuration export with JSON loading
```

## Configuration Precedence & Inheritance

1. Environment variables (highest priority)
2. JSON environment configuration with `_extends` inheritance
3. Base configuration files (TypeScript)
4. Default values

### JSON Inheritance

JSON configurations support inheritance using the `_extends` field:

```json
{
  "_comment": "Development environment configuration", 
  "_extends": "test",
  "site": {
    "domain": "dev.example.com"
  },
  "app": {
    "features": {
      "enableDebugLogging": true
    }
  }
}
```

This allows:
- **Base configurations**: Common settings shared across environments
- **Environment-specific overrides**: Only specify what's different
- **Test inheritance**: Unit and integration tests extend base test configuration
- **Custom environments**: Create specialized environments for specific scenarios

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

```json
// Development config (config/environments/development.json)
{
  "app": {
    "backend": { "url": "http://localhost:4000" },
    "frontend": { "url": "http://localhost:3000" }
  }
}

// Production config (config/environments/production.json)
// No backend/frontend URLs needed - CDK handles this via:
// - config.site.domain → Load Balancer domain
// - Environment variables set by CDK at runtime
```

## Type Safety

All configuration is strongly typed using TypeScript interfaces defined in `packages/config-loader/schemas/`. The loading library provides runtime validation to ensure configuration integrity.

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