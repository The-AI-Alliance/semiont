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
  /**
   * Capabilities delegated to this agent from the minting client, stamped at
   * `/api/tokens/agent` (EXTRACT-JOBS P0). Today the only one is `WORKER_ROLE`,
   * carried when a worker mints the agent's token, so the dispatcher can
   * authorize the agent's `job:claim`. Absent on a non-worker's agent token —
   * an agent is not a service account and never inherits `SERVICE_ROLE`.
   */
  roles: z.array(z.string()).optional(),
  iat: z.number().optional(),
  exp: z.number().optional(),
});

// Base Zod-inferred type
type JWTPayloadBase = z.infer<typeof JWTPayloadSchema>;

// Branded version for type safety
export type JWTPayload = Omit<JWTPayloadBase, 'email'> & {
  email: Email;
};
