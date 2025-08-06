/**
 * Local Environment Configuration
 * 
 * Configuration for local development using Docker containers
 * This is for running services on your local machine with containers
 */

import type { EnvironmentOverrides } from '../schemas/config.schema';

export const localConfig: EnvironmentOverrides = {
  // No stacks needed for local environment - uses Docker containers
  site: {
    // Local development site configuration
    domain: 'localhost',
    adminEmail: 'admin@localhost.dev',
    supportEmail: 'support@localhost.dev',
    oauthAllowedDomains: ['localhost.dev', 'gmail.com']
  },
  app: {
    features: {
      enableAnalytics: false,
      enableMaintenanceMode: false,
      enableDebugLogging: true
    },
    security: {
      sessionTimeout: 28800, // 8 hours for local development
      maxLoginAttempts: 20, // Very lenient for local development
      corsAllowedOrigins: ['http://localhost:3000', 'http://localhost:3001']
    },
    performance: {
      enableCaching: false,  // Disable caching for local development
      cacheTimeout: 0
    },
    backend: {
      url: 'http://localhost:3001', // Local backend port (different from cloud dev)
      database: {
        host: 'localhost',
        port: 5432,
        name: 'semiont_local',
        user: 'postgres'
      }
    },
    frontend: {
      url: 'http://localhost:3000'
    }
  }
  // Note: No AWS configuration - local environment uses Docker containers only
};