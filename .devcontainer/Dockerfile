# Semiont Development Container
# Pre-built image with PostgreSQL and all development tools
FROM mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm

USER root

# Install PostgreSQL 16
# Add PostgreSQL APT repository for version 16
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        gnupg \
        wget && \
    wget --quiet -O - https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/postgresql-keyring.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/postgresql-keyring.gpg] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list && \
    apt-get update && \
    apt-get install -y postgresql-16 postgresql-contrib-16 && \
    rm -rf /var/lib/apt/lists/*

# Configure PostgreSQL
RUN mkdir -p /var/run/postgresql && \
    chown -R postgres:postgres /var/run/postgresql && \
    chmod 2777 /var/run/postgresql

# Create PostgreSQL data directory with proper permissions
RUN mkdir -p /var/lib/postgresql/data && \
    chown -R postgres:postgres /var/lib/postgresql && \
    chmod 700 /var/lib/postgresql/data

# Initialize PostgreSQL database cluster as postgres user
RUN su - postgres -c "/usr/lib/postgresql/16/bin/initdb -D /var/lib/postgresql/data"

# Configure PostgreSQL to listen on localhost
RUN echo "listen_addresses = 'localhost'" >> /var/lib/postgresql/data/postgresql.conf && \
    echo "port = 5432" >> /var/lib/postgresql/data/postgresql.conf

# Create semiont database user and database
RUN service postgresql start && \
    su - postgres -c "psql -c \"CREATE USER semiont WITH PASSWORD 'semiont';\"" && \
    su - postgres -c "psql -c \"CREATE DATABASE semiont OWNER semiont;\"" && \
    su - postgres -c "psql -c \"GRANT ALL PRIVILEGES ON DATABASE semiont TO semiont;\"" && \
    service postgresql stop

# Create startup script for PostgreSQL
RUN echo '#!/bin/bash\n\
service postgresql start\n\
# Wait for PostgreSQL to be ready\n\
for i in {1..30}; do\n\
  if pg_isready -h localhost -p 5432 -U semiont > /dev/null 2>&1; then\n\
    echo "PostgreSQL is ready"\n\
    break\n\
  fi\n\
  if [ $i -eq 30 ]; then\n\
    echo "PostgreSQL failed to start"\n\
    exit 1\n\
  fi\n\
  sleep 1\n\
done\n' > /usr/local/bin/start-postgres.sh && \
    chmod +x /usr/local/bin/start-postgres.sh

# Install additional build tools that might be needed
RUN apt-get update && \
    apt-get install -y build-essential python3 python3-pip && \
    rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /workspace

# Switch to node user for development
USER node

# Set environment variables
ENV DATABASE_URL="postgresql://semiont:semiont@localhost:5432/semiont?schema=public"
ENV NODE_ENV="development"
