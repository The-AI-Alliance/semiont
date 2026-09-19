import { Context, Next } from 'hono';
import { principalFromToken } from '../identity/principal';
import { bearerChallenge } from '../identity/resource-metadata';
import { JWTService } from '../auth/jwt';
import type { Principal } from '../identity/principal';
import { accessToken } from '@semiont/core';

interface Variables {
  /** The authenticated caller, built from the token's own claims. */
  principal: Principal;
  /**
   * The DID identifying the authenticated principal — a Person or a Software
   * peer. Used as `_userId` on bus emits and as the `creator` on resource
   * creation, so callers don't have to know which they are dealing with.
   *
   * The same string as `principal.did`, set separately because that is how
   * every consumer reads it and threading the whole principal to each of them
   * would say less, not more.
   */
  principalDid: string;
}

export interface AuthContext extends Context {
  get: <T extends keyof Variables>(key: T) => Variables[T];
  set: <T extends keyof Variables>(key: T, value: Variables[T]) => void;
}

// Resource paths that accept ?token= media tokens (GET only)
const MEDIA_TOKEN_PATH = /^\/api\/resources\/([^/]+)$/;

export const authMiddleware = async (c: Context, next: Next): Promise<Response | void> => {
  const logger = c.get('logger');

  // For GET /api/resources/:id, accept a short-lived media token via ?token=
  if (c.req.method === 'GET') {
    const mediaTokenParam = c.req.query('token');
    const match = c.req.path.match(MEDIA_TOKEN_PATH);
    const resourceId = match?.[1];
    if (mediaTokenParam && resourceId) {
      try {
        JWTService.verifyMediaToken(mediaTokenParam, resourceId);
        // Media tokens are stateless and resource-scoped: the token names the
        // resource it may fetch, so there is no principal to resolve and none
        // is set. A route reached this way sees no `user` and no
        // `principalDid`, which is correct — nothing about the holder is known
        // beyond their having been given this one token for this one resource.
        await next();
        return;
      } catch (error) {
        logger.warn('Authentication failed: Invalid media token', {
          type: 'auth_failed',
          reason: 'invalid_media_token',
          path: c.req.path,
          error: error instanceof Error ? error.message : String(error)
        });
        return c.json({ error: 'Unauthorized' }, 401);
      }
    }
  }

  const authHeader = c.req.header('Authorization');
  let tokenStr: string | undefined;
  if (authHeader?.startsWith('Bearer ')) {
    tokenStr = authHeader.substring(7).trim();
  }

  if (!tokenStr) {
    logger.warn('Authentication failed: No token', {
      type: 'auth_failed',
      reason: 'missing_token',
      path: c.req.path,
      method: c.req.method
    });
    // Actionable body (SDK-AUTH-CORS Phase 6): keep the machine-readable
    // `error` code, add a `hint` so a bare-IRI browser navigation / a script
    // that forgot the header gets one line naming the fix.
    c.header('WWW-Authenticate', bearerChallenge(c));
    return c.json({
      error: 'Unauthorized',
      hint: 'Authentication required: send an `Authorization: Bearer <token>` header. A raw browser navigation to a protected resource is unauthenticated.',
    }, 401);
  }

  try {
    const principal = await principalFromToken(accessToken(tokenStr));

    c.set('principal', principal);
    c.set('principalDid', principal.did);

    logger.debug('Authentication successful', {
      type: 'auth_success',
      did: principal.did,
      email: principal.email,
      path: c.req.path,
      method: c.req.method
    });

    await next();
    return;
  } catch (error) {
    logger.warn('Authentication failed: Invalid token', {
      type: 'auth_failed',
      reason: 'invalid_token',
      path: c.req.path,
      method: c.req.method,
      error: error instanceof Error ? error.message : String(error)
    });
    c.header('WWW-Authenticate', bearerChallenge(c, 'invalid_token'));
    return c.json({ error: 'Invalid token' }, 401);
  }
};

export const optionalAuthMiddleware = async (c: Context, next: Next) => {
  const authHeader = c.req.header('Authorization');

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const tokenStr = authHeader.substring(7);

    try {
      const principal = await principalFromToken(accessToken(tokenStr));
      c.set('principal', principal);
      c.set('principalDid', principal.did);
    } catch (error) {
      // Ignore auth errors for optional auth
    }
  }

  await next();
};
