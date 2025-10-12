import { z } from 'zod';
import type { GoogleAuthRequest } from '@semiont/sdk';

// JWT Payload schema - backend-specific internal type for JWT validation
export const JWTPayloadSchema = z.object({
  userId: z.string().regex(/^c[a-z0-9]{24,}$/), // CUID format
  email: z.string().email(),
  name: z.string().optional(),
  domain: z.string(),
  provider: z.string(),
  isAdmin: z.boolean(),
  iat: z.number().optional(),
  exp: z.number().optional(),
});

export type JWTPayload = z.infer<typeof JWTPayloadSchema>;

// Re-export GoogleAuthRequest type from SDK
export type { GoogleAuthRequest };