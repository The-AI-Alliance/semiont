import { z } from '@hono/zod-openapi';

/**
 * Google Auth Request - OAuth access token for login
 */
export const GoogleAuthRequestSchema = z.object({
  access_token: z.string().openapi({
    example: 'ya29.a0AfH6SMBx...',
    description: 'OAuth 2.0 access token from authentication provider',
  }),
});

export type GoogleAuthRequest = z.infer<typeof GoogleAuthRequestSchema>;

/**
 * OAuth Config Response
 */
export const OAuthConfigResponseSchemaActual = z.object({
  providers: z.array(z.object({
    name: z.string(),
    isConfigured: z.boolean(),
    clientId: z.string(),
  })),
  allowedDomains: z.array(z.string()),
});

export type OAuthConfigResponseActual = z.infer<typeof OAuthConfigResponseSchemaActual>;

/**
 * OAuth Provider Schema
 */
export const OAuthProviderSchema = z.object({
  name: z.string(),
  clientId: z.string(),
  isConfigured: z.boolean(),
});

export type OAuthProvider = z.infer<typeof OAuthProviderSchema>;

/**
 * OAuth Config Response
 */
export const OAuthConfigResponseSchema = z.object({
  providers: z.array(OAuthProviderSchema),
  allowedDomains: z.array(z.string()),
});

export type OAuthConfigResponse = z.infer<typeof OAuthConfigResponseSchema>;

/**
 * Token Refresh Response
 */
export const TokenRefreshResponseSchema = z.object({
  access_token: z.string(),
});

export type TokenRefreshResponse = z.infer<typeof TokenRefreshResponseSchema>;

/**
 * MCP Generate Response
 */
export const MCPGenerateResponseSchema = z.object({
  refresh_token: z.string(),
});

export type MCPGenerateResponse = z.infer<typeof MCPGenerateResponseSchema>;

/**
 * Logout Response
 */
export const LogoutResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

export type LogoutResponse = z.infer<typeof LogoutResponseSchema>;

/**
 * Accept Terms Response
 */
export const AcceptTermsResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

export type AcceptTermsResponse = z.infer<typeof AcceptTermsResponseSchema>;

// ============================================================================
// OpenAPI-wrapped Schemas (for Hono routes - just call .openapi() on schemas above)
// ============================================================================

export const GoogleAuthRequestSchemaOpenAPI = GoogleAuthRequestSchema.openapi('GoogleAuthRequest');
export const OAuthConfigResponseSchemaActualOpenAPI = OAuthConfigResponseSchemaActual.openapi('OAuthConfigResponse');
export const TokenRefreshResponseSchemaOpenAPI = TokenRefreshResponseSchema.openapi('TokenRefreshResponse');
export const MCPGenerateResponseSchemaOpenAPI = MCPGenerateResponseSchema.openapi('MCPGenerateResponse');
export const LogoutResponseSchemaOpenAPI = LogoutResponseSchema.openapi('LogoutResponse');
export const AcceptTermsResponseSchemaOpenAPI = AcceptTermsResponseSchema.openapi('AcceptTermsResponse');
