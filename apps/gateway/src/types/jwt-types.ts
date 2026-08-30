import { z } from 'zod';
import type { GoogleAuthRequest, UserId } from '@semiont/core';
import type { Email } from '@semiont/core';

// JWT Payload schema - backend-specific internal type for JWT validation
export const JWTPayloadSchema = z.object({
  userId: z.string().regex(/^c[a-z0-9]{24,}$/), // CUID format
  email: z.string().email(),
  name: z.string().optional(),
  domain: z.string(),
  provider: z.string(),
  isAdmin: z.boolean(),
  // For software-agent tokens: the agent's DID is asserted by the auth
  // route (which knows the (inferenceProvider, model) the token is being
  // issued for) and carried on the JWT. The bus uses this directly as
  // `_userId` instead of recomputing `userToDid(user)`. Unset for human
  // tokens.
  agentDid: z.string().optional(),
  // Per-user revocation epoch (SDK-AUTH-CORS Phase 2): every token carries the
  // user's tokenVersion at mint; logout bumps User.tokenVersion, so a token
  // whose tokenVersion is behind the user's current value is rejected.
  // Required — a token minted before this feature lacks the claim and fails
  // validation, so the holder re-authenticates. That is the intended
  // revoke-every-session-on-rollout behavior, not a regression.
  tokenVersion: z.number().int(),
  iat: z.number().optional(),
  exp: z.number().optional(),
});

// Base Zod-inferred type
type JWTPayloadBase = z.infer<typeof JWTPayloadSchema>;

// Branded version for type safety
export type JWTPayload = Omit<JWTPayloadBase, 'userId' | 'email'> & {
  userId: UserId;
  email: Email;
};

// Re-export GoogleAuthRequest type from SDK
export type { GoogleAuthRequest };
