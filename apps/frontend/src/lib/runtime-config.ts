/**
 * Runtime configuration for server-side code
 * This works around Next.js standalone mode limitations with environment variables
 */

export function getRuntimeConfig() {
  // In standalone mode, process.env might not have runtime variables
  // But they ARE in the Node.js process environment
  // We need to explicitly read them
  
  return {
    oauthAllowedDomains: process.env.OAUTH_ALLOWED_DOMAINS || '',
    // Add other runtime configs here as needed
  };
}