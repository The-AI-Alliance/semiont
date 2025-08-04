// Configuration for backend application
// These values are validated and typed via environment variables

import { env } from './config/env';

export const CONFIG = {
  SITE_NAME: env.SITE_NAME,
  DOMAIN: env.DOMAIN,
  OAUTH_ALLOWED_DOMAINS: env.OAUTH_ALLOWED_DOMAINS,
  DATABASE_NAME: env.DATABASE_NAME || 'semiont',
  PORT: env.PORT,
  NODE_ENV: env.NODE_ENV,
  DATABASE_URL: env.DATABASE_URL,
  JWT_SECRET: env.JWT_SECRET,
  CORS_ORIGIN: env.CORS_ORIGIN,
  FRONTEND_URL: env.FRONTEND_URL,
};