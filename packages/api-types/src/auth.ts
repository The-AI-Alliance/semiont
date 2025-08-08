/**
 * Authentication and authorization related types
 */

import { z } from 'zod';
import { EmailSchema, CuidSchema } from './common';

// Authentication request schemas
export const GoogleAuthSchema = z.object({
  access_token: z.string().min(1, 'Access token is required'),
});

// JWT Payload validation schema
export const JWTPayloadSchema = z.object({
  userId: CuidSchema,
  email: EmailSchema,
  name: z.string().min(1).max(255).optional(),
  domain: z.string().min(1).max(100),
  provider: z.string().min(1).max(50),
  isAdmin: z.boolean(),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
}).refine(
  (data) => data.exp > data.iat,
  {
    message: "Token expiration must be after issued time",
    path: ["exp"],
  }
).refine(
  (data) => data.exp > Math.floor(Date.now() / 1000),
  {
    message: "Token has expired",
    path: ["exp"],
  }
);

// User information interface (used in auth responses)
export interface UserInfo {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  domain: string;
  isAdmin: boolean;
}

// Authentication response interface
export interface AuthResponse {
  success: boolean;
  user: UserInfo;
  token: string;
  isNewUser: boolean;
}

// Logout response interface
export interface LogoutResponse {
  success: boolean;
  message: string;
}

// Type inference from schemas
export type GoogleAuthRequest = z.infer<typeof GoogleAuthSchema>;
export type JWTPayload = z.infer<typeof JWTPayloadSchema>;