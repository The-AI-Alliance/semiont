import type { Context } from 'hono';

export const PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';

/**
 * The token an `Authorization: Bearer …` header carries, or undefined when
 * there is none. The scheme is matched case-insensitively (RFC 7235 §2.1);
 * whatever follows it is the token, trimmed, and nothing following it is no
 * token at all.
 */
export function bearerToken(header: string | undefined): string | undefined {
  const token = header ? /^bearer(?:[ \t]+(.*))?$/i.exec(header)?.[1]?.trim() : undefined;
  return token ? token : undefined;
}

/**
 * The `WWW-Authenticate` challenge on every 401 (RFC 6750 §3): it names the
 * resource's metadata (RFC 9728 §5.1), so a client learns where to sign in
 * from the refusal itself, and says `invalid_token` when a token was
 * presented and refused.
 */
export function bearerChallenge(c: Context, error?: 'invalid_token'): string {
  const metadata = `resource_metadata="${new URL(c.req.url).origin}${PROTECTED_RESOURCE_METADATA_PATH}"`;
  return error ? `Bearer error="${error}", ${metadata}` : `Bearer ${metadata}`;
}

/**
 * The 401 for a request that presented no credential, on every protected
 * route: the challenge, and a `hint` naming the header — a bare browser
 * navigation or a script that forgot it gets the fix in one line.
 */
export function missingCredential(c: Context): Response {
  c.header('WWW-Authenticate', bearerChallenge(c));
  return c.json({
    error: 'Unauthorized',
    hint: 'Authentication required: send an `Authorization: Bearer <token>` header. A raw browser navigation to a protected resource is unauthenticated.',
  }, 401);
}
