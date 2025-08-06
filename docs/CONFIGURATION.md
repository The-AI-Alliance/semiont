# Semiont Configuration Guide

This document describes how configuration is managed in the Semiont application, including the centralized configuration system, environment variables, secrets, and deployment settings.

## Overview

Semiont uses a **centralized configuration system** located in `/config` with **configuration-as-code** deployment through AWS CDK. This ensures consistent configuration across environments and secure handling of sensitive data.

## Configuration Architecture

### 1. **Centralized Configuration System**

All configuration originates from the `/config` directory:

```
/config/
├── README.md                    # Configuration documentation
├── base/                        # Base configurations
│   ├── site.config.ts          # Site-specific settings
│   ├── aws.config.ts           # AWS infrastructure settings
│   ├── app.config.ts           # Application settings
│   └── site.config.example.ts  # Example template
├── environments/               # Environment-specific overrides
│   ├── development.ts          # Development overrides
│   └── production.ts           # Production settings
├── schemas/                    # Type definitions
│   ├── config.schema.ts       # TypeScript interfaces
│   └── validation.ts          # Runtime validation
└── index.ts                   # Main configuration export
```

### 2. **CDK Integration**

The CDK infrastructure uses the centralized configuration:

- **Infrastructure Stack** (`cdk/lib/infra-stack.ts`): Defines RDS, secrets, and core resources using centralized config
- **Application Stack** (`cdk/lib/app-stack.ts`): Configures ECS tasks with environment variables from centralized config
- **CDK Entry Point** (`cdk/bin/cdk.ts`): Imports configuration from `/config`

### 3. **Dual-Service Architecture**

Semiont runs as two separate ECS services:

- **Frontend Service**: Next.js application with public environment variables
- **Backend Service**: Node.js API with database access and secrets
- **Service Communication**: Frontend communicates with backend via ALB routing

### 4. **Configuration Flow**

```
Centralized Config → CDK Infrastructure → ECS Task Definition → Container Environment → Application
```

1. Configuration defined in `/config` with environment-specific overrides
2. CDK provisions AWS resources using centralized configuration
3. CDK outputs are used to configure ECS task environment variables
4. Containers receive environment variables at startup
5. Applications use environment variables for configuration

## Quick Start

### For Development

1. **Initialize Configuration**
   ```bash
   npm run config:init
   ```

2. **Customize Development Environment**
   Edit `/config/environments/development.ts` and replace all example values with your development-specific settings:
   ```typescript
   export const developmentConfig: EnvironmentOverrides = {
     site: {
       domain: 'your-dev-wiki.yourdomain.com',
       adminEmail: 'admin@yourdomain.com',
       supportEmail: 'support@yourdomain.com',
       oauthAllowedDomains: ['yourdomain.com']
     },
     aws: {
       accountId: 'your-aws-account-id',
       certificateArn: 'your-development-certificate-arn',
       hostedZoneId: 'your-development-hosted-zone-id',
       rootDomain: 'yourdomain.com'
     }
   };
   ```

3. **Validate Configuration** (development is the default)
   ```bash
   npm run config:validate
   ```

4. **Deploy**
   ```bash
   npm run deploy
   ```

   Note: SEMIONT_ENV defaults to development, so no environment variable is needed.

### For Production (custom deployment)

1. **Initialize Configuration**
   ```bash
   npm run config:init
   ```

2. **Customize Production Environment**
   Edit `/config/environments/production.ts` and replace all example values:
   ```typescript
   export const productionConfig: EnvironmentOverrides = {
     site: {
       domain: 'your-wiki.yourdomain.com',
       adminEmail: 'admin@yourdomain.com',
       supportEmail: 'support@yourdomain.com',
       oauthAllowedDomains: ['yourdomain.com']
     },
     aws: {
       accountId: 'your-aws-account-id',
       certificateArn: 'your-certificate-arn',
       hostedZoneId: 'your-hosted-zone-id',
       rootDomain: 'yourdomain.com'
     }
   };
   ```

3. **Set SEMIONT_ENV to production**
   ```bash
   export SEMIONT_ENV=production
   ```

4. **Validate Configuration**
   ```bash
   npm run config:validate
   ```

5. **Deploy**
   ```bash
   npm run deploy
   ```

## Configuration Files

### Base Configuration Files

Base configuration files contain default settings and common values:

- **`/config/base/site.config.ts`** - General site settings (site name, description)
- **`/config/base/aws.config.ts`** - AWS infrastructure defaults (region, stack names)
- **`/config/base/app.config.ts`** - Application runtime settings

⚠️ **Important**: The base configurations no longer contain hardcoded values for deployment-specific settings. You must configure these in environment-specific files.

### Environment-Specific Configuration

All deployment-specific settings are configured in environment files:

#### Development Environment (`/config/environments/development.ts`)

Contains example values for local development that **MUST BE CUSTOMIZED** for your deployment:

| Setting | Example Value | Description |
|---------|---------------|-------------|
| `site.domain` | `'wiki.dev.example.com'` | Your development domain |
| `site.adminEmail` | `'admin@dev.example.com'` | Your development admin email |
| `site.supportEmail` | `'support@dev.example.com'` | Your development support email |
| `site.oauthAllowedDomains` | `['dev.example.com']` | Your allowed development domains |
| `aws.accountId` | `'123456789012'` | Your AWS account ID |
| `aws.certificateArn` | Example ARN | Your development SSL certificate ARN |
| `aws.hostedZoneId` | `'ZDEVZONEID123'` | Your development Route 53 hosted zone ID |
| `aws.rootDomain` | `'dev.example.com'` | Your development root domain |

#### Production Environment (`/config/environments/production.ts`)

Contains example values that **MUST BE CUSTOMIZED** for your deployment:

| Setting | Example Value | Description |
|---------|---------------|-------------|
| `site.domain` | `'wiki.example.com'` | Your actual domain |
| `site.adminEmail` | `'admin@example.com'` | Your admin email |
| `site.supportEmail` | `'support@example.com'` | Your support email |
| `site.oauthAllowedDomains` | `['example.com']` | Your allowed domains |
| `aws.accountId` | `'123456789012'` | Your AWS account ID |
| `aws.certificateArn` | Example ARN | Your SSL certificate ARN |
| `aws.hostedZoneId` | `'Z1234567890ABC'` | Your Route 53 hosted zone ID |
| `aws.rootDomain` | `'example.com'` | Your root domain |

### Application Configuration (`/config/base/app.config.ts`)

Runtime application settings:

| Setting | Description | Default |
|---------|-------------|---------|
| `nodeEnv` | Environment mode | `"production"` |
| `features.enableAnalytics` | Enable analytics tracking | `false` |
| `security.sessionTimeout` | Session timeout in seconds | `28800` (8 hours) |
| `performance.enableCaching` | Enable application caching | `true` |

## Configuration vs Secrets

Semiont makes a clear distinction between **configuration** and **secrets**:

### Configuration (Public Settings)
- **Location**: `/config/environments/` files (checked into git)
- **Purpose**: Business logic settings that can be public
- **Examples**: 
  - `oauthAllowedDomains` - Which email domains can sign in
  - `sessionTimeout` - How long sessions last
  - `enableAnalytics` - Feature flags
  - Domain names and public settings

### Secrets (Private Credentials)
- **Location**: AWS Secrets Manager (never in git)
- **Purpose**: Sensitive credentials and deployment-specific values
- **Management**: `semiont secrets` command
- **Examples**:
  - `oauth/google` - OAuth client ID and secret
  - `oauth/github` - GitHub OAuth credentials  
  - `jwt-secret` - JWT signing key
  - `app-secrets` - Session encryption keys

### Managing Secrets

Use the `semiont secrets` command to manage sensitive values:

```bash
# List all available secrets
semiont secrets list

# View a secret (values are masked for security)
semiont secrets get oauth/google

# Set OAuth credentials interactively
semiont secrets set oauth/google

# Set a simple secret with a value
semiont secrets set jwt-secret "your-32-character-secret-key"

# Set complex JSON secret
semiont secrets set oauth/github '{"clientId":"...","clientSecret":"..."}'
```

## Environment Variables

### SEMIONT_ENV vs NODE_ENV

Semiont uses `SEMIONT_ENV` instead of `NODE_ENV` to determine which environment configuration to load:

- **`SEMIONT_ENV=development`**: Uses `/config/environments/development.ts` (default)
- **`SEMIONT_ENV=production`**: Uses `/config/environments/production.ts`
- **`SEMIONT_ENV=test`**: Base test configuration (rarely used directly)
- **`SEMIONT_ENV=unit`**: Unit test configuration with mocked dependencies
- **`SEMIONT_ENV=integration`**: Integration test configuration with Testcontainers

This allows Semiont to have its own environment configuration independent of your Node.js application's `NODE_ENV`.

#### Test Environment Hierarchy

The test environments follow an inheritance pattern:

```
test.ts (base)
├── unit.ts (extends test + mockMode: true)
└── integration.ts (extends test + useTestcontainers: true)
```

- **test**: Base configuration with common test settings (disabled features, test domains)
- **unit**: Fast, isolated tests with mocked database and external services
- **integration**: Tests with real PostgreSQL database via Testcontainers

### Environment Variable Overrides

Configuration values can be overridden using environment variables:

```bash
# Semiont-specific environment (determines which config environment to use)
export SEMIONT_ENV="production"  # or "development"

# Site configuration
export SITE_NAME="My Site"
export DOMAIN="example.com"
export ADMIN_EMAIL="admin@example.com"
export OAUTH_ALLOWED_DOMAINS="example.com,partner.com"

# AWS configuration  
export AWS_REGION="us-east-1"
export AWS_ACCOUNT_ID="123456789012"
export CERTIFICATE_ARN="arn:aws:acm:..."

# Application configuration
export SESSION_TIMEOUT="28800"
```

## Backend Configuration

The backend application receives the following environment variables (automatically configured by CDK from centralized config):

### Environment Variables

#### **Database Configuration**
- `DATABASE_URL` - Complete PostgreSQL connection string (constructed from secrets)
- `DB_HOST` - RDS endpoint from CDK
- `DB_PORT` - PostgreSQL port (5432)
- `DB_NAME` - Database name (semiont)

#### **Application Settings**
- `NODE_ENV` - Environment mode (production)
- `PORT` - Server port (4000)
- `AWS_REGION` - AWS region

#### **CORS & Frontend Integration**
- `CORS_ORIGIN` - Frontend domain for CORS
- `FRONTEND_URL` - Frontend URL

#### **OAuth Configuration**
- `OAUTH_ALLOWED_DOMAINS` - Comma-separated list of allowed email domains

### Secrets (via AWS Secrets Manager)

The backend receives secrets through AWS Secrets Manager:

#### **Database Credentials Secret**
- `DB_USER` - Database username
- `DB_PASSWORD` - Database password (auto-generated)

#### **JWT Secret**
- `JWT_SECRET` - JWT signing secret for API authentication

#### **Google OAuth Secret**
- `GOOGLE_CLIENT_ID` - OAuth Google client ID
- `GOOGLE_CLIENT_SECRET` - OAuth Google client secret

#### **App Secrets**
- `SESSION_SECRET` - Session encryption secret
- `NEXTAUTH_SECRET` - NextAuth.js encryption secret

### Database Connection

The backend uses a complete `DATABASE_URL` constructed from the database credentials:

```bash
# Automatically constructed from AWS Secrets Manager
DATABASE_URL=postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}?sslmode=require
```

## Frontend Configuration

### Environment Variables

The frontend (Next.js) receives these environment variables (automatically configured by CDK from centralized config):

#### **Application Settings**
- `NODE_ENV` - Build environment
- `PORT` - Server port
- `HOSTNAME` - Bind address

#### **Public Variables** (Available to Browser)
- `NEXT_PUBLIC_API_URL` - Backend API endpoint
- `NEXT_PUBLIC_SITE_NAME` - Site name
- `NEXT_PUBLIC_DOMAIN` - Site domain
- `NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS` - Comma-separated list of allowed email domains

#### **NextAuth.js Configuration**
- `NEXTAUTH_SECRET` - NextAuth.js encryption secret (from app secrets)
- `NEXTAUTH_URL` - Full application URL for OAuth callbacks
- `GOOGLE_CLIENT_ID` - Google OAuth client ID (from Google OAuth secret)
- `GOOGLE_CLIENT_SECRET` - Google OAuth client secret (from Google OAuth secret)

### Type-Safe Environment Access

The frontend uses a centralized environment configuration:

```typescript
// src/lib/env.ts
export const env = {
  API_URL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000',
  SITE_NAME: process.env.NEXT_PUBLIC_SITE_NAME || 'Semiont',
  DOMAIN: process.env.NEXT_PUBLIC_DOMAIN || 'localhost',
  NODE_ENV: process.env.NODE_ENV || 'development',
} as const;
```

## Configuration CLI

Semiont provides a CLI for managing configuration:

```bash
# Initialize configuration from example
npm run config:init

# Show current configuration (sensitive data masked)
npm run config:show

# Validate configuration
npm run config:validate

# Export as environment variables
npm run config:export > .env

# Show environment information
npm run config:env
```

## Development vs Production

### Development Environment

For local development, use `.env.example` files:

```bash
# Backend (.env)
cp apps/backend/.env.example apps/backend/.env
# Edit with local database credentials

# Frontend (.env.local)  
cp apps/frontend/.env.example apps/frontend/.env.local
# Edit with local API URL
```

### Production Environment

In production, **all configuration comes from the centralized config system and CDK**:

- Configuration defined in `/config` with environment overrides
- Environment variables are set by ECS task definitions using centralized config
- Secrets are injected from AWS Secrets Manager
- No manual configuration files needed

## Configuration Management

### 1. **Updating Site Configuration**

Modify environment-specific configuration files:

```typescript
// /config/environments/production.ts
export const productionConfig: EnvironmentOverrides = {
  site: {
    // Update site settings
    oauthAllowedDomains: ['company.com', 'newdomain.com'],
  }
};
```

After updating configuration, redeploy:
```bash
npm run deploy
```

### 2. **OAuth Configuration**

#### Setting Up Google OAuth

The Semiont platform supports OAuth authentication with Google using NextAuth.js. When configured, users can log in using their Google accounts with domain-based access restrictions.

**Prerequisites:**
- Semiont deployment must be complete and accessible via HTTPS
- AWS CLI access to update Secrets Manager
- Access to Google Cloud Console
- Domain ownership verification (for OAuth consent screen)

**Step 1: Create Google OAuth Application**

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Navigate to **APIs & Services** > **Credentials**
4. Click **Create Credentials** > **OAuth 2.0 Client IDs**

**Step 2: Configure OAuth Consent Screen**

1. Go to **APIs & Services** > **OAuth consent screen**
2. Choose **External** user type (unless using Google Workspace)
3. Fill in required fields:
   - **App name**: Your application name
   - **User support email**: Your support email
   - **Developer contact information**: Your contact email
4. Add your domain to **Authorized domains**
5. Configure **Publication status**:
   - **Testing**: Only specified test users can sign in
   - **In production**: Any Google user can sign in (requires verification for sensitive scopes)

**Step 3: Create OAuth 2.0 Client ID**

1. In **APIs & Services** > **Credentials**, click **Create Credentials** > **OAuth 2.0 Client IDs**
2. Select **Web application** as the application type
3. Configure the client:
   - **Name**: A descriptive name for your OAuth client
   - **Authorized JavaScript origins**: `https://your-domain.com`
   - **Authorized redirect URIs**: `https://your-domain.com/api/auth/callback/google`
4. Save the **Client ID** and **Client Secret**

**Step 4: Required APIs**

Ensure these APIs are enabled in **APIs & Services** > **Library**:
- **Google+ API** (legacy but sometimes required)
- **People API**
- **Google Identity Services API**

#### OAuth Management Tools

Use the secrets management command for OAuth credentials:

```bash
# Set OAuth credentials
./scripts/semiont secrets set oauth/google

# Check OAuth credential status
./scripts/semiont secrets get oauth/google

# List all secrets including OAuth
./scripts/semiont secrets list
```


### 3. **Environment-Specific Overrides**

Create environment-specific overrides in `/config/environments/`:

```typescript
// Example development override
export const developmentConfig: EnvironmentOverrides = {
  app: {
    features: {
      enableDebugLogging: true
    },
    security: {
      sessionTimeout: 86400  // 24 hours for dev
    }
  }
};
```

### 4. **Applying Configuration Changes**

After any configuration change:

```bash
# Validate configuration
npm run config:validate

# Deploy changes
npm run deploy

# Restart services to pick up new configuration
./scripts/semiont restart
```

## Health Checks & Monitoring

### Backend Health Endpoint

The backend provides comprehensive health information at `/api/health`.

Response includes:
- Application status
- Database connectivity
- Environment information
- Version details

### Configuration Validation

The application validates configuration at startup:

1. **Configuration schema validation** is performed
2. **Database connectivity** is tested
3. **Required environment variables** are checked
4. **Health endpoints** verify configuration
5. **Startup logs** show configuration status

## Security Considerations

### 1. **Secrets Management**
- All sensitive data uses AWS Secrets Manager
- No secrets in environment variables or code
- Automatic secret rotation supported

### 2. **Environment Isolation**
- Development and production use separate resources
- Configuration is environment-specific
- No cross-environment data leakage

### 3. **Access Control**
- ECS tasks have minimal IAM permissions
- Only necessary secrets are accessible
- Database access is restricted by security groups

### 4. **Configuration Security**
- Never commit secrets to git
- Use `.env.local` for local development (gitignored)
- Validate domains - ensure `oauthAllowedDomains` is restrictive
- Regular configuration reviews

### 5. **OAuth Security**
- Keep OAuth Client Secrets secure and rotate them regularly
- Use specific redirect URIs, never wildcards
- Review OAuth application permissions periodically
- Monitor failed authentication attempts
- Regularly review the allowed domains list
- Consider additional authorization rules beyond domain checking
- Monitor login attempts via application logs
- Implement session management and timeout policies

## Troubleshooting

### Common Configuration Issues

1. **Invalid Domain Configuration**
   ```
   Error: Valid domain is required
   Field: site.domain
   ```
   **Solution**: Ensure domain follows format `subdomain.example.com`

2. **Missing AWS Credentials**
   ```
   Error: Valid AWS account ID is required
   Field: aws.accountId
   ```
   **Solution**: Find your 12-digit account ID in AWS Console

3. **Certificate ARN Mismatch**
   ```
   Error: Certificate must be in us-east-1 for CloudFront
   ```
   **Solution**: Create certificate in us-east-1 region for CloudFront compatibility

4. **Database Connection Failures**
   ```bash
   # Check database endpoint
   ./scripts/semiont exec backend 'echo $DB_HOST'
   
   # Test database connectivity
   ./scripts/semiont exec backend 'pg_isready -h $DB_HOST -p $DB_PORT'
   
   # Check complete DATABASE_URL
   ./scripts/semiont exec backend 'echo $DATABASE_URL | sed "s/:.*@/:***@/"'
   ```

5. **Frontend API Connection Issues**
   ```bash
   # Check API URL configuration
   curl https://your-domain.com/api/health
   
   # Check frontend environment variables
   ./scripts/semiont exec frontend 'env | grep NEXT_PUBLIC'
   ```

6. **OAuth Configuration Issues**

   **"invalid_client (Unauthorized)"**
   - **Causes**: Incorrect Client ID/Secret, wrong redirect URI, OAuth app not configured
   - **Solutions**: Verify credentials match exactly, ensure redirect URI is `https://your-domain.com/api/auth/callback/google`

   **"Your email domain is not allowed"**
   - **Causes**: User's email domain not in `OAUTH_ALLOWED_DOMAINS`, environment variable not set
   - **Solutions**: Add domain to allowed domains list, verify environment variables, redeploy and restart services

   **"This app isn't verified"**
   - **Causes**: OAuth app in testing mode but user not in test users list
   - **Solutions**: Add users to test users list (testing mode) or submit app for verification (production mode)

   ```bash
   # Check OAuth status
   ./scripts/semiont secrets get oauth/google
   
   # Check OAuth environment variables
   ./scripts/semiont exec frontend 'env | grep -E "(GOOGLE|NEXTAUTH|OAUTH)"'
   
   # View OAuth logs
   ./scripts/semiont logs frontend tail
   
   # Follow logs during OAuth testing
   ./scripts/semiont logs frontend follow
   ```

### Configuration Debugging

Use the management scripts and configuration CLI to inspect configuration:

```bash
# Check current configuration
npm run config:show

# Validate configuration
npm run config:validate

# Check deployment status
./scripts/semiont status

# View application logs (both services)
./scripts/semiont logs follow

# View service-specific logs
./scripts/semiont logs frontend tail
./scripts/semiont logs backend tail

# Execute commands in specific containers
./scripts/semiont exec frontend 'env'
./scripts/semiont exec backend 'env'

# Check OAuth configuration
./scripts/semiont secrets get oauth/google

# Restart services after configuration changes
./scripts/semiont restart
```

## Migration from Old Configuration

If migrating from an older version using `cdk/lib/shared-config.ts`:

1. Configuration is automatically migrated on first use
2. Old imports continue to work but show deprecation warnings
3. Update imports when convenient:
   ```typescript
   // Old
   import { SITE_CONFIG } from './cdk/lib/shared-config';
   
   // New
   import { config } from './config';
   ```

## Best Practices

1. **Use centralized configuration** - Define all settings in `/config`
2. **Use environment-specific overrides** - Keep environment differences in `/config/environments/`
3. **Use CDK for all infrastructure** - Avoid manual AWS console changes
4. **Use configuration management scripts** - Prefer `npm run config:*` and `./scripts/semiont secrets` over manual commands
5. **Test configuration changes** in development first
6. **Use environment-specific values** - Never hardcode production URLs
7. **Validate configuration** - Always run `npm run config:validate` before deployment
8. **Restart services after config changes** - Configuration is cached in containers
9. **Rotate secrets regularly** using AWS Secrets Manager
10. **Monitor configuration drift** with AWS Config or CloudFormation drift detection
11. **Document configuration changes** in git commits and pull requests
12. **Use service-specific commands** - Specify frontend/backend for exec and logs commands

## Related Documentation

- [Deployment Guide](DEPLOYMENT.md) - How to deploy configuration changes
- [Development Setup](../README.md) - Local development configuration  
- [Security Guide](./SECURITY.md) - Security best practices
- [Troubleshooting Guide](TROUBLESHOOTING.md) - Configuration-related issues