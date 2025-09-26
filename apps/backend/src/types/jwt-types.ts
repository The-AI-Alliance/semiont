import { z } from 'zod';

// JWT Payload schema - matches the structure from api-contracts but defined locally
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

// Google Auth Request schema
export const GoogleAuthRequestSchema = z.object({
  token: z.string(),
});

export type GoogleAuthRequest = z.infer<typeof GoogleAuthRequestSchema>;