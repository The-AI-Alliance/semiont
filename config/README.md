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

## Type Safety

All configuration is strongly typed using TypeScript interfaces. Runtime validation ensures configuration integrity.

## Sensitive Data

Never commit sensitive data like API keys or secrets. Use:
- Environment variables for local development
- AWS Secrets Manager for production
- `.env.local` files (gitignored) for local overrides