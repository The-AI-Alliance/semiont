/**
 * Site-Specific Configuration
 * 
 * This file contains all site-specific settings that need to be customized
 * for each deployment. This is the primary file you need to update when
 * deploying Semiont to your own domain.
 */

import type { SiteConfiguration } from '../schemas/config.schema';

export const siteConfig: SiteConfiguration = {
  // Site branding
  siteName: process.env.SITE_NAME || 'Semiont',
  siteDescription: 'Your semantic knowledge platform',
  
  // Domain configuration - Must be configured in environment-specific configs
  domain: process.env.DOMAIN || '',
  ...(process.env.SUBDOMAIN && { subdomain: process.env.SUBDOMAIN }),  // Optional subdomain
  
  // Contact information - Must be configured in environment-specific configs
  adminEmail: process.env.ADMIN_EMAIL || '',
  supportEmail: process.env.SUPPORT_EMAIL || '',
  
  // OAuth configuration - Must be configured in environment-specific configs
  oauthAllowedDomains: process.env.OAUTH_ALLOWED_DOMAINS?.split(',').map(d => d.trim()) || [],
  oauthProviders: [
    {
      name: 'google',
      enabled: true,
      clientIdEnvVar: 'GOOGLE_CLIENT_ID',
      secretName: 'semiont/oauth/google'
    },
    {
      name: 'github',
      enabled: false,  // Disabled by default
      clientIdEnvVar: 'GITHUB_CLIENT_ID',
      secretName: 'semiont/oauth/github'
    }
  ]
};