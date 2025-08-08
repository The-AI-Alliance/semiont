/**
 * Example Site Configuration
 * 
 * Copy this file to site.config.ts and update with your values
 */

import type { SiteConfiguration } from '../schemas/config.schema';

export const siteConfig: SiteConfiguration = {
  // Site branding
  siteName: 'My Knowledge Base',  // Your site name
  siteDescription: 'A semantic knowledge platform for our team',
  
  // Domain configuration
  domain: 'kb.example.com',  // Your domain
  subdomain: undefined,      // Optional: 'staging' would create staging.kb.example.com
  
  // Contact information
  adminEmail: 'admin@example.com',    // Admin notifications
  supportEmail: 'support@example.com', // Support contact
  
  // OAuth configuration
  oauthAllowedDomains: ['example.com'],  // Email domains allowed to sign in
  oauthProviders: [
    {
      name: 'google',
      enabled: true,
      clientIdEnvVar: 'GOOGLE_CLIENT_ID',
      secretName: 'semiont/oauth/google'
    },
    {
      name: 'github',
      enabled: false,
      clientIdEnvVar: 'GITHUB_CLIENT_ID', 
      secretName: 'semiont/oauth/github'
    }
  ]
};