# Database Management Guide

This guide explains how Semiont manages its PostgreSQL database, including schema management, migrations, and operational procedures.

## Overview

Semiont uses PostgreSQL as its primary database, managed through AWS RDS with the following components:

- **Database Engine**: PostgreSQL 15.x on AWS RDS
- **ORM**: Prisma for schema definition and database access
- **Migration Strategy**: Automatic migrations on backend startup
- **Connection Management**: Connection pooling via Prisma Client

**Event-Sourced Architecture**: Semiont uses an event-sourced architecture for annotations. The PostgreSQL database contains both:
- **Layer 2 (Event Store)**: Immutable event log in JSONL files - source of truth for all annotation changes (see [EVENT-STORE.md](./EVENT-STORE.md))
- **Layer 3 (Projection)**: Materialized current state - filesystem JSON files and `annotations` table in PostgreSQL - optimized for fast queries (see [PROJECTION.md](./PROJECTION.md))

See [W3C-WEB-ANNOTATION.md](../specs/docs/W3C-WEB-ANNOTATION.md), [EVENT-STORE.md](./EVENT-STORE.md), and [PROJECTION.md](./PROJECTION.md) for detailed architecture and how annotations flow through all layers.

## Database Architecture

### Data Infrastructure

- **AWS RDS PostgreSQL**: Multi-AZ deployment in private subnets
- **Security Groups**: Database access restricted to ECS tasks only
- **Encryption**: Data encrypted at rest and in transit
- **Backups**: Automated daily backups with 7-day retention
- **Credentials**: Stored securely in AWS Secrets Manager

### Schema Definition

The database schema is defined in `/apps/backend/prisma/schema.prisma`:

```prisma
// Example current schema
model User {
  id        String   @id @default(cuid())
  email     String   @unique
  name      String?
  image     String?
  domain    String
  provider  String   @default("google")
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@map("users")
}
```

## Migration Management

### Automatic Migrations

Semiont uses **automatic migrations on startup** rather than traditional migration files:

1. **On Backend Startup**: The backend container automatically runs `npx prisma db push`
2. **Schema Sync**: Prisma compares the schema file to the database and applies changes
3. **No Migration Files**: Changes are applied directly from the schema definition
4. **Safe Deployment**: Prisma only applies non-destructive changes automatically

### Migration Process

```javascript
// From apps/backend/src/index.ts
async function runMigrations() {
  try {
    console.log('📝 Running database migrations...');
    const { execSync } = require('child_process');
    execSync('npx prisma db push', { stdio: 'inherit' });
    console.log('✅ Database migrations completed');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    // Server continues to start even if migrations fail
  }
}
```

### Why This Approach?

- **Simplicity**: No migration file management
- **Consistency**: Schema definition is the single source of truth
- **Development Speed**: Fast iteration during development
- **Automatic Deployment**: No manual migration steps required

## Database Operations

### Connecting to the Database

Database credentials are managed through AWS Secrets Manager and automatically injected into the ECS containers.

#### From Local Development

```bash
# Get database connection string
SECRET_NAME=$(aws cloudformation describe-stacks \
  --stack-name YourDataStackName \
  --query 'Stacks[0].Outputs[?OutputKey==`DatabaseSecretName`].OutputValue' \
  --output text)

DATABASE_URL=$(aws secretsmanager get-secret-value \
  --secret-id "$SECRET_NAME" \
  --query 'SecretString' \
  --output text | jq -r '"postgresql://" + .username + ":" + .password + "@" + .host + ":" + (.port|tostring) + "/" + .dbname')

# Use with Prisma commands
DATABASE_URL="$DATABASE_URL" npx prisma studio
```

#### From ECS Container

```bash
# Access backend container
semiont exec --service backend /bin/sh

# Inside container, Prisma uses DATABASE_URL automatically
npx prisma studio --port 5555 --hostname 0.0.0.0
```

### Common Database Tasks

#### Viewing Database Status

```bash
# Check database connection from backend
semiont exec --service backend "npx prisma db pull --print"

# View current schema
semiont exec --service backend "cat prisma/schema.prisma"
```

#### Manual Schema Changes

1. **Update Schema**: Edit `/apps/backend/prisma/schema.prisma`
2. **Deploy Changes**: Run `semiont publish`
3. **Automatic Migration**: Backend container will apply changes on startup

#### Prisma Studio (Database Browser)

```bash
# From local machine (requires database access)
DATABASE_URL="postgresql://..." npx prisma studio

# From ECS container (recommended)
semiont exec --service backend "npx prisma studio --port 5555 --hostname 0.0.0.0"
# Then access via port forwarding or ALB
```

#### Resetting Database

```bash
# WARNING: This will delete all data
semiont exec --service backend "npx prisma db push --force-reset"
```

## Schema Evolution

### Adding New Tables

1. Add the new model to `schema.prisma`:

```prisma
model Article {
  id        String   @id @default(cuid())
  title     String
  content   String
  authorId  String
  author    User     @relation(fields: [authorId], references: [id])
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@map("articles")
}

// Update User model to include relation
model User {
  // ... existing fields
  articles  Article[]
}
```

2. Deploy the changes:

```bash
semiont publish
```

3. Verify migration in logs:

```bash
semiont watch logs --service backend
```

### Modifying Existing Tables

**Safe Changes** (applied automatically):
- Adding optional columns
- Adding indexes
- Creating new tables
- Adding relations

**Unsafe Changes** (require manual intervention):
- Dropping columns
- Changing column types
- Making columns required
- Dropping tables

For unsafe changes, use `--force-reset` or manual SQL:

```bash
# For development environments only
semiont exec --service backend "npx prisma db push --force-reset"
```

## Backup and Recovery

### Automated Backups

- **Daily Snapshots**: Automatic RDS snapshots at 3 AM UTC
- **Retention**: 7 days for automated snapshots
- **Point-in-Time Recovery**: Available for up to 7 days

### Manual Backup

```bash
# Create manual snapshot
aws rds create-db-snapshot \
  --db-instance-identifier your-db-instance \
  --db-snapshot-identifier manual-backup-$(date +%Y%m%d-%H%M) \
  --region your-region
```

### Disaster Recovery

1. **Restore from Snapshot**: Use AWS Console or CLI to restore RDS instance
2. **Update Connection**: Update database endpoint in Secrets Manager
3. **Redeploy**: Deploy app stack to pick up new database connection
4. **Verify**: Test application functionality

## Monitoring and Maintenance

### Database Health Checks

The backend includes automatic database health monitoring:

```javascript
// From apps/backend/src/index.ts
app.get('/api/health', async (c) => {
  let dbStatus = 'unknown';
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbStatus = 'connected';
  } catch (error) {
    dbStatus = 'disconnected';
  }
  // ... return status
});
```

### Performance Monitoring

```bash
# Check database metrics
aws cloudwatch get-metric-statistics \
  --namespace AWS/RDS \
  --metric-name CPUUtilization \
  --dimensions Name=DBInstanceIdentifier,Value=your-db-instance \
  --start-time $(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 300 \
  --statistics Average \
  --region your-region
```

### Log Analysis

```bash
# View database logs
semiont watch logs --service backend | grep -i database

# Check for connection issues
semiont watch logs --service backend | grep -i "prisma\|database\|connection"
```

## Security Considerations

### Access Control

- **Network Isolation**: Database in private subnets, no internet access
- **Security Groups**: Only ECS tasks can connect to database
- **Encryption**: TLS in transit, AES-256 at rest
- **IAM Integration**: Uses IAM roles for RDS authentication where possible

### Credential Management

- **AWS Secrets Manager**: Database credentials rotated automatically
- **No Hardcoded Passwords**: All credentials injected at runtime
- **Least Privilege**: Database user has only necessary permissions

### Audit Trail

- **CloudTrail**: All database management operations logged
- **RDS Logs**: Query logging enabled for security analysis
- **Application Logs**: Database operations logged in application

## Troubleshooting

### Common Issues

#### Connection Timeouts

```bash
# Check security groups
aws ec2 describe-security-groups --group-ids your-security-group-id

# Verify database endpoint
aws rds describe-db-instances --db-instance-identifier your-db-instance
```

#### Migration Failures

```bash
# Check migration logs
semiont watch logs --service backend | grep -A 10 -B 10 "Running database migrations"

# Manual migration
semiont exec --service backend "npx prisma db push --accept-data-loss"
```

#### Schema Drift

```bash
# Compare schema to database
semiont exec --service backend "npx prisma db pull"

# Reset to match schema
semiont exec --service backend "npx prisma db push --force-reset"
```

### Emergency Procedures

#### Database Locked

1. **Check Active Connections**:
   ```sql
   SELECT * FROM pg_stat_activity WHERE state = 'active';
   ```

2. **Kill Long-Running Queries**:
   ```sql
   SELECT pg_terminate_backend(pid) FROM pg_stat_activity 
   WHERE query_start < now() - interval '5 minutes';
   ```

#### Corruption Recovery

1. **Stop Application**: Scale ECS services to 0
2. **Restore from Backup**: Use most recent clean snapshot
3. **Update Connection**: Point application to restored database
4. **Restart Application**: Scale ECS services back up

## Development Workflow

### Local Development

1. **Set up Local Database**:
   ```bash
   docker run --name semiont-postgres -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=semiont -p 5432:5432 -d postgres:15
   ```

2. **Connect to Local DB**:
   ```bash
   export DATABASE_URL="postgresql://postgres:dev@localhost:5432/semiont"
   npx prisma db push
   ```

3. **Sync with Production Schema**:
   ```bash
   # Pull production schema
   DATABASE_URL="production_url" npx prisma db pull
   
   # Apply to local
   npx prisma db push
   ```

### Staging Environment

- **Separate RDS Instance**: Isolated from production
- **Data Refresh**: Periodic refresh from production snapshots
- **Migration Testing**: Test schema changes before production

## Future Considerations

### Scaling Strategy

- **Read Replicas**: For read-heavy workloads
- **Connection Pooling**: PgBouncer for high-concurrency applications
- **Sharding**: Database partitioning for massive scale

### Advanced Features

- **Point-in-Time Recovery**: More granular backup strategy
- **Cross-Region Replication**: Disaster recovery across regions
- **Database Monitoring**: Enhanced monitoring with custom metrics

### Migration to Traditional Migrations

If the project grows and requires more controlled migrations:

1. **Switch to `prisma migrate`**: Use traditional migration files
2. **Version Control**: Store migration files in git
3. **Deployment Pipeline**: Run migrations as separate deployment step
4. **Rollback Strategy**: Implement migration rollback procedures