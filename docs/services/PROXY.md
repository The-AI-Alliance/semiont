# Proxy Service

The proxy service routes HTTP/HTTPS traffic between the frontend and backend services. The implementation varies by platform, but all provide the same core routing functionality.

## Platform Implementations

### Local Development & Codespaces: Envoy
**Configuration**: `apps/cli/templates/envoy.yaml`

Envoy proxy is used for local development and GitHub Codespaces environments. It provides:
- HTTP/2 support
- Server-Sent Events (SSE) with proper timeouts
- Flexible routing configuration
- Built-in health checks and metrics

### AWS Platform: Application Load Balancer (ALB)
**Configuration**: Managed via AWS infrastructure

AWS deployments use ALB for production traffic routing. ALB provides:
- Native AWS integration
- SSL/TLS termination
- Health checks and auto-scaling integration
- AWS WAF integration for security

### Other Platforms
Platform-appropriate equivalents will be chosen for all supported platforms (e.g., nginx, HAProxy, cloud-native load balancers).

## Routing Architecture

All proxy implementations follow the same routing pattern (first match wins):

```
Priority  Path Pattern         Target      Notes
--------  -------------------  ----------  -------------------------
1         /api/auth/*          Frontend    NextAuth.js authentication
2         /api/cookies/*       Frontend    Cookie consent/export
3         /api/resources/*     Frontend    Authenticated image proxy
4         /resources (exact)   Backend     POST /resources creation
5         /resources/*         Backend     SSE streams, resource APIs
6         /annotations/*       Backend     Annotation CRUD
7         /admin/*             Backend     Admin APIs
8         /entity-types/*      Backend     Entity type management
9         /jobs/*              Backend     Job queue APIs
10        /users/*             Backend     User management
11        /tokens/*            Backend     Token management
12        /health              Backend     Health check
13        /status              Backend     Status endpoint
14        /api/*               Backend     OpenAPI docs, spec
15        /*                   Frontend    Next.js pages (catch-all)
```

## Critical Configuration: SSE Support

### The Problem
Server-Sent Events (SSE) require long-lived HTTP connections that can remain open for extended periods. Many proxies have default timeouts (typically 30 seconds) that will close these connections prematurely, causing missed events during real-time operations like AI generation.

### The Solution
The `/resources/*` route must be configured with extended timeouts to support SSE streams at `/resources/:id/events/stream`.

#### Envoy Configuration
```yaml
# Match /resources/* (prefix - for GET /resources/:id)
# Increased timeout for SSE streams at /resources/:id/events/stream
- match:
    prefix: "/resources/"
  route:
    cluster: backend
    timeout: 0s  # No timeout for SSE long-lived connections
    idle_timeout: 3600s  # 1 hour idle timeout
```

**Key settings:**
- `timeout: 0s` - Removes request timeout for long-lived SSE connections
- `idle_timeout: 3600s` - Keeps connection open for 1 hour of inactivity

#### ALB Configuration
For AWS ALB, configure:
- **Idle timeout**: 3600 seconds (1 hour) minimum
- **Target group health checks**: Separate from SSE connection handling
- **Connection draining**: Allow graceful shutdown without dropping SSE connections

### Why This Matters
Without proper SSE timeout configuration:
1. SSE connections disconnect after the default timeout (typically 30s)
2. Frontend loses real-time updates during long operations
3. AI generation events are missed (e.g., `annotation.body.updated`)
4. Users see stale data until manual refresh

With proper configuration:
1. SSE connections remain open for the duration of the operation
2. Real-time events stream correctly to the frontend
3. UI updates automatically as annotations are resolved
4. Better user experience during AI-powered workflows

## Service Endpoints

### Frontend (Next.js)
- **Development**: `localhost:3000`
- **Docker**: `host.docker.internal:3000`
- **AWS**: ECS service on private subnet

### Backend (Hono API)
- **Development**: `localhost:4000`
- **Docker**: `host.docker.internal:4000`
- **AWS**: ECS service on private subnet

## Configuration Files

### Local Development Template
**File**: `apps/cli/templates/envoy.yaml`

Template variables:
- `{{HOST_ADDRESS}}` - Resolves to `localhost` or appropriate host
- `{{BACKEND_PORT}}` - Backend service port (default: 4000)
- `{{FRONTEND_PORT}}` - Frontend service port (default: 3000)

The CLI replaces these variables based on the environment when starting services.

### Production Deployment
**AWS**: ALB configuration is managed via infrastructure as code (Terraform/CloudFormation)

Key ALB settings:
- Listener port: 443 (HTTPS)
- Target groups: frontend and backend ECS services
- Health check paths: `/health` for backend, `/api/health` for frontend
- Idle timeout: 3600s for SSE support

## Path Matching Details

### Exact vs Prefix Matching

**Exact match** (`path: "/resources"`):
- Matches only `/resources` exactly
- Used for POST requests to create resources
- Does not match `/resources/` or `/resources/123`

**Prefix match** (`prefix: "/resources/"`):
- Matches `/resources/*` patterns
- Used for GET requests to individual resources
- Matches `/resources/123`, `/resources/123/events/stream`, etc.

This distinction ensures:
- Creation endpoint has standard timeout (30s)
- SSE streaming endpoints have extended timeout (0s)
- Resource retrieval endpoints have extended timeout (0s)

## Timeouts Summary

| Route Pattern | Timeout | Idle Timeout | Reason |
|--------------|---------|--------------|--------|
| `/resources` (exact) | 30s | Default | Resource creation is quick |
| `/resources/*` | 0s | 3600s | SSE streams need long-lived connections |
| All other routes | 30s | Default | Standard request/response |

## Monitoring

### Envoy Admin Interface
**URL**: `http://localhost:9901`

Available endpoints:
- `/stats` - Proxy statistics
- `/clusters` - Backend cluster status
- `/config_dump` - Current configuration
- `/logging` - Log level control

### ALB Metrics (AWS)
CloudWatch metrics:
- `TargetResponseTime` - Backend latency
- `HealthyHostCount` - Available backend instances
- `HTTPCode_Target_4XX_Count` - Client errors
- `HTTPCode_Target_5XX_Count` - Server errors

## Security Considerations

### CORS Handling
CORS is handled by the backend and frontend services, not the proxy:
- Backend sets appropriate CORS headers for API routes
- Frontend handles CORS for proxied resource requests
- Proxy simply forwards requests and responses

### SSL/TLS
- **Local**: HTTP only (no encryption needed)
- **AWS**: ALB handles SSL termination, internal traffic uses HTTP

### Rate Limiting
Rate limiting is typically handled at:
- **Application layer**: Backend API implements rate limiting
- **Platform layer**: AWS WAF for production deployments
- **Proxy layer**: Can be configured but not required for local development

## Troubleshooting

### SSE Connections Dropping
**Symptom**: Real-time updates stop working after 30 seconds

**Solution**: Verify SSE timeout configuration:
1. Check `/resources/*` route has `timeout: 0s`
2. Check `idle_timeout` is set to at least 3600s
3. Restart proxy service after configuration changes

### Route Priority Issues
**Symptom**: Requests going to wrong service (e.g., backend OpenAPI docs served by frontend)

**Solution**: Check route order - more specific routes must come before general catch-alls:
- `/api/auth/*` must come before `/api/*`
- `/api/cookies/*` must come before `/api/*`
- `/resources` (exact) must come before `/resources/*` (prefix)

### Health Check Failures
**Symptom**: Proxy reports backend/frontend as unhealthy

**Solution**:
1. Verify services are running: `semiont check --service all`
2. Test endpoints directly: `curl http://localhost:4000/health`
3. Check service logs for startup errors

## Related Documentation

- **Real-Time Events**: [apps/backend/docs/REAL-TIME.md](../../apps/backend/docs/REAL-TIME.md) - SSE architecture and Event Handler Refs Pattern
- **AI Generation**: [docs/ai/GENERATION.md](../ai/GENERATION.md) - How SSE enables real-time AI updates
- **CLI Documentation**: [apps/cli/README.md](../../apps/cli/README.md) - Service management commands
- **AWS Deployment**: [docs/platforms/AWS.md](../platforms/AWS.md) - Production ALB configuration
