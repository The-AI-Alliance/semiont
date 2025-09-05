# Adding and Managing Environments in Semiont CLI

This guide explains how to create and manage environments, which are the primary configuration mechanism in Semiont CLI.

## Overview

Environments are the central configuration concept in Semiont:
- **Define deployment contexts** (dev, staging, production)
- **Specify which services exist** in each environment
- **Configure platform assignments** for each service
- **Provide environment-specific settings** (ports, env vars, resources)
- **Required for all commands** via `--environment` or `SEMIONT_ENV`

## Core Concepts Hierarchy

```
Environment
    ├── Services (which services exist)
    ├── Platform Assignments (where each service runs)
    ├── Service Configurations (how each service is configured)
    └── Platform Settings (AWS regions, Docker registries, etc.)
```

## Creating a New Environment

### 1. Create Environment File

Create a JSON file in the `environments/` directory:

```bash
touch environments/my-env.json
```

### 2. Define Environment Structure

```json
{
  "platform": {
    "default": "container"  // Default platform for services
  },
  "services": {
    // Define each service that exists in this environment
  },
  // Platform-specific settings (optional)
  "aws": {
    "region": "us-west-2",
    "profile": "my-profile"
  },
  "container": {
    "registry": "docker.io"
  }
}
```

### 3. Add Service Definitions

For each service in your environment, specify:
- **platform**: Which platform to use (overrides default)
- **Service configuration**: Port, environment variables, resources
- **Service-specific settings**: Based on service type

```json
{
  "services": {
    "backend": {
      "platform": "posix",
      "port": 3000,
      "command": "npm start",
      "env": {
        "NODE_ENV": "development",
        "API_URL": "http://localhost:3000"
      }
    },
    "database": {
      "platform": "container",
      "image": "postgres:15",
      "port": 5432,
      "env": {
        "POSTGRES_DB": "myapp",
        "POSTGRES_USER": "user",
        "POSTGRES_PASSWORD": "${DB_PASSWORD}"  // Can reference env vars
      },
      "volumes": [
        "/data/postgres:/var/lib/postgresql/data"
      ]
    },
    "worker": {
      "platform": "aws",
      "serviceType": "lambda",  // Hint for AWS platform
      "memory": 512,
      "timeout": 300,
      "env": {
        "QUEUE_URL": "https://sqs.us-west-2.amazonaws.com/123/my-queue"
      }
    }
  }
}
```

## Environment Examples

### Local Development Environment

```json
{
  "platform": {
    "default": "posix"  // Use local processes by default
  },
  "services": {
    "frontend": {
      "port": 3000,
      "command": "npm run dev",
      "env": {
        "NODE_ENV": "development",
        "API_URL": "http://localhost:3001"
      }
    },
    "backend": {
      "port": 3001,
      "command": "npm run dev:backend",
      "env": {
        "NODE_ENV": "development",
        "DATABASE_URL": "postgresql://localhost:5432/dev"
      }
    },
    "database": {
      "platform": "container",  // Override to use Docker
      "image": "postgres:15-alpine",
      "port": 5432,
      "env": {
        "POSTGRES_DB": "dev",
        "POSTGRES_USER": "developer",
        "POSTGRES_PASSWORD": "localpass"
      }
    }
  }
}
```

### Staging Environment

```json
{
  "platform": {
    "default": "container"  // Use containers by default
  },
  "services": {
    "frontend": {
      "image": "myorg/frontend:staging",
      "port": 80,
      "env": {
        "NODE_ENV": "staging",
        "API_URL": "https://api-staging.example.com"
      }
    },
    "backend": {
      "image": "myorg/backend:staging",
      "port": 3000,
      "replicas": 2,
      "env": {
        "NODE_ENV": "staging",
        "DATABASE_URL": "${STAGING_DB_URL}"
      },
      "resources": {
        "memory": "512Mi",
        "cpu": "500m"
      }
    },
    "database": {
      "platform": "external",  // Use external managed database
      "host": "staging-db.example.com",
      "port": 5432
    }
  },
  "container": {
    "registry": "registry.example.com",
    "network": "staging-network"
  }
}
```

### Production Environment (AWS)

```json
{
  "platform": {
    "default": "aws"
  },
  "services": {
    "frontend": {
      "serviceType": "s3-cloudfront",
      "bucket": "prod-frontend",
      "distribution": "E1234567890ABC"
    },
    "backend": {
      "serviceType": "ecs",
      "cluster": "prod-cluster",
      "service": "backend-service",
      "taskDefinition": "backend:latest",
      "desiredCount": 3,
      "env": {
        "NODE_ENV": "production"
      }
    },
    "worker": {
      "serviceType": "lambda",
      "functionName": "prod-worker",
      "memory": 1024,
      "timeout": 900,
      "env": {
        "NODE_ENV": "production"
      }
    },
    "database": {
      "serviceType": "rds",
      "instanceIdentifier": "prod-database",
      "engine": "postgres",
      "instanceClass": "db.t3.medium"
    }
  },
  "aws": {
    "region": "us-west-2",
    "profile": "production",
    "stackName": "prod-infrastructure"
  }
}
```

## Platform-Specific Configuration

### AWS Platform Settings

```json
{
  "aws": {
    "region": "us-west-2",           // AWS region
    "profile": "my-profile",         // AWS CLI profile
    "stackName": "my-stack",         // CloudFormation stack
    "vpcId": "vpc-12345",           // VPC for resources
    "subnets": ["subnet-1", "subnet-2"],
    "securityGroups": ["sg-12345"]
  }
}
```

### Container Platform Settings

```json
{
  "container": {
    "runtime": "docker",             // or "podman"
    "registry": "registry.example.com",
    "network": "my-network",
    "compose": {
      "file": "docker-compose.yml",
      "project": "myproject"
    }
  }
}
```

### POSIX Platform Settings

```json
{
  "posix": {
    "workingDirectory": "/opt/myapp",
    "user": "appuser",
    "logDirectory": "/var/log/myapp"
  }
}
```

## Service Type Hints

Help the platform determine the correct service type:

```json
{
  "services": {
    "api": {
      "platform": "aws",
      "serviceType": "lambda",  // Explicit service type
      // ... lambda-specific config
    },
    "webapp": {
      "platform": "aws",
      "serviceType": "ecs",     // ECS Fargate service
      // ... ECS-specific config
    },
    "cdn": {
      "platform": "aws",
      "serviceType": "s3-cloudfront",  // Static hosting
      // ... S3/CloudFront config
    }
  }
}
```

## Environment Variables

### Referencing Environment Variables

Use `${VAR_NAME}` syntax to reference environment variables:

```json
{
  "services": {
    "backend": {
      "env": {
        "DATABASE_URL": "${DATABASE_URL}",
        "API_KEY": "${API_KEY}",
        "NODE_ENV": "production"
      }
    }
  }
}
```

### Setting SEMIONT_ENV

The environment can be specified via:

```bash
# Command line flag (highest priority)
semiont start backend --environment staging

# Environment variable
export SEMIONT_ENV=staging
semiont start backend

# Error if neither is set
semiont start backend
# Error: Environment is required. Specify --environment flag or set SEMIONT_ENV
```

## Service Dependencies

Define dependencies between services:

```json
{
  "services": {
    "backend": {
      "dependencies": ["database", "cache"],
      // backend won't start until database and cache are running
    },
    "frontend": {
      "dependencies": ["backend"],
      // frontend waits for backend
    }
  }
}
```

## Resource Configuration

Specify resource requirements per service:

```json
{
  "services": {
    "backend": {
      "resources": {
        "memory": "1Gi",      // Memory limit
        "cpu": "1000m",       // CPU limit (1 core)
        "storage": "10Gi"     // Storage requirement
      }
    }
  }
}
```

## Multi-Environment Strategies

### Shared Configuration

Create a base configuration and extend it:

```javascript
// environments/base.json
{
  "platform": {
    "default": "container"
  },
  "services": {
    "backend": {
      "port": 3000,
      "healthCheck": "/health"
    }
  }
}

// environments/staging.json
{
  "extends": "./base.json",  // Inherit from base
  "services": {
    "backend": {
      "image": "myorg/backend:staging",
      "replicas": 2
    }
  }
}
```

### Environment Promotion

Structure environments for promotion workflow:

```
environments/
├── dev.json       # Local development
├── test.json      # Automated testing
├── staging.json   # Pre-production
└── prod.json      # Production
```

## Validation

### Required Fields

Each service must have:
- A unique name (object key)
- Platform assignment (explicit or default)

### Platform Compatibility

Ensure service configurations match platform capabilities:
- **posix**: Requires `command`
- **container**: Requires `image` or Dockerfile
- **aws**: Requires service-type specific fields

## Best Practices

### 1. Environment Naming

Use clear, consistent naming:
```
dev.json         # Local development
staging.json     # Staging environment
prod.json        # Production
feature-x.json   # Feature branch environment
```

### 2. Sensitive Data

Don't commit sensitive data. Use environment variables:
```json
{
  "services": {
    "database": {
      "env": {
        "PASSWORD": "${DB_PASSWORD}"  // Reference, don't hardcode
      }
    }
  }
}
```

### 3. Service Naming

Use consistent service names across environments:
```json
// Good: Same names in all environments
"services": {
  "backend": { ... },
  "frontend": { ... },
  "database": { ... }
}

// Bad: Different names per environment
"services": {
  "backend-dev": { ... },  // Don't do this
  "frontend-staging": { ... }
}
```

### 4. Platform Selection

Choose platforms based on environment needs:
- **Development**: `posix` for quick iteration
- **Testing**: `container` for consistency
- **Production**: `aws` for scalability

### 5. Configuration Validation

Test environment configurations:
```bash
# Validate environment loads correctly
semiont check all --environment my-env

# Dry run to verify configuration
semiont start all --environment my-env --dry-run
```

## Testing Environments

### Create Test Environment

```json
{
  "platform": {
    "default": "mock"  // Use mock platform for testing
  },
  "services": {
    "backend": {
      "port": 3000,
      "mockResponses": true
    },
    "database": {
      "inMemory": true
    }
  }
}
```

### CI/CD Integration

```yaml
# .github/workflows/deploy.yml
env:
  SEMIONT_ENV: ${{ github.ref == 'refs/heads/main' && 'prod' || 'staging' }}

steps:
  - run: semiont deploy all
```

## Troubleshooting

### Environment Not Found

```bash
Error: Environment configuration not found: environments/typo.json
```
- Check file exists
- Verify path is correct
- Ensure JSON is valid

### Service Not Defined

```bash
Error: Service "backend" not found in environment "dev"
```
- Check service is defined in environment file
- Verify service name spelling

### Platform Mismatch

```bash
Error: No handler found for command "start" on platform "aws" with service type "unknown"
```
- Add `serviceType` hint for AWS services
- Ensure platform has handlers for the service type

## Environment Lifecycle

### Creating
1. Define requirements
2. Create JSON file
3. Add services
4. Configure platforms
5. Test configuration

### Updating
1. Modify environment file
2. Test changes locally
3. Deploy to environment
4. Verify services

### Deprecating
1. Document deprecation
2. Migrate services
3. Update automation
4. Archive configuration

## Summary

Environments are the foundation of Semiont CLI configuration:
- **Central configuration** for all deployments
- **Service definitions** specify what exists
- **Platform assignments** determine where services run
- **Environment-specific settings** configure behavior
- **Required for execution** via `--environment` or `SEMIONT_ENV`

The relationship between core concepts:
```
Environment → defines → Services
                    ↓
            assigns to → Platforms
                    ↓
            categorizes as → Service Types
                    ↓
            executes via → Commands
```

Remember: Environment is not just configuration—it's the primary context that determines which services exist, how they're deployed, and how they're configured.