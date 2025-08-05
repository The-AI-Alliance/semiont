/**
 * Application Configuration
 * 
 * Runtime application settings including feature flags,
 * security configuration, and performance tuning.
 */

import type { ApplicationConfiguration } from '../schemas/config.schema';

export const appConfig: ApplicationConfiguration = {
  // Environment
  nodeEnv: (process.env.SEMIONT_ENV as 'development' | 'staging' | 'production') || 'development',
  
  // Feature flags
  features: {
    enableAnalytics: process.env.ENABLE_ANALYTICS === 'true' || false,
    enableMaintenanceMode: process.env.ENABLE_MAINTENANCE_MODE === 'true' || false,
    enableDebugLogging: process.env.ENABLE_DEBUG_LOGGING === 'true' || false
  },
  
  // Security configuration
  security: {
    sessionTimeout: parseInt(process.env.SESSION_TIMEOUT || '28800', 10), // 8 hours default
    maxLoginAttempts: parseInt(process.env.MAX_LOGIN_ATTEMPTS || '5', 10),
    corsAllowedOrigins: process.env.CORS_ALLOWED_ORIGINS?.split(',').map(o => o.trim()) || []
  },
  
  // Performance configuration
  performance: {
    enableCaching: process.env.ENABLE_CACHING !== 'false', // Default true
    cacheTimeout: parseInt(process.env.CACHE_TIMEOUT || '300', 10), // 5 minutes
    maxRequestSize: process.env.MAX_REQUEST_SIZE || '10mb'
  },
  
  // Backend configuration
  backend: {
    host: process.env.BACKEND_HOST || 'localhost',
    port: parseInt(process.env.BACKEND_PORT || '4000', 10),
    database: {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      name: process.env.DB_NAME || 'semiont',
      user: process.env.DB_USER || 'postgres'
    },
    frontend: {
      host: process.env.FRONTEND_HOST || 'localhost',
      port: parseInt(process.env.FRONTEND_PORT || '3000', 10)
    }
  }
};