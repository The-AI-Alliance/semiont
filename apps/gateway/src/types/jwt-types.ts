import { z } from 'zod';
import type { Email } from '@semiont/core';

/**
 * The payload of a token the GATEWAY signs. Software agents only: people are
 * minted tokens by the trusted issuer, whose claims this schema never sees.
 *
 * `did` replaces what used to be `userId`, a cuid naming a row in a table that
 * no longer exists. The DID is the identity everything downstream keys on, so
 * carrying it directly means the token says what the bus, resource creation
 * and the signal ledger all read — with no lookup in between to disagree.
 */
export const JWTPayloadSchema = z.object({
  /** `did:web:<domain>:agents:<provider>:<model>`. */
  did: z.string().startsWith('did:'),
  email: z.string().email(),
  name: z.string().optional(),
  /** The deployment's domain, which issues the agent's DID. */
  domain: z.string(),
  iat: z.number().optional(),
  exp: z.number().optional(),
});

// Base Zod-inferred type
type JWTPayloadBase = z.infer<typeof JWTPayloadSchema>;

// Branded version for type safety
export type JWTPayload = Omit<JWTPayloadBase, 'email'> & {
  email: Email;
};
