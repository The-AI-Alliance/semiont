import type { Context } from 'hono';
import { trustedIssuer } from './trusted-issuer';

export const PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';

/**
 * The `WWW-Authenticate` challenge on a 401 (RFC 6750 §3). When this
 * resource trusts an issuer, the challenge names the resource's metadata
 * (RFC 9728 §5.1), so a client learns where to sign in from the refusal
 * itself.
 */
export function bearerChallenge(c: Context, error?: 'invalid_token'): string {
  const params: string[] = [];
  if (error) {
    params.push(`error="${error}"`);
  }
  if (trustedIssuer()) {
    params.push(`resource_metadata="${new URL(c.req.url).origin}${PROTECTED_RESOURCE_METADATA_PATH}"`);
  }
  return params.length ? `Bearer ${params.join(', ')}` : 'Bearer';
}
