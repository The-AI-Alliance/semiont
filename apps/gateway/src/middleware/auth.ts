import { Context, Next } from 'hono';
import { principalFromToken } from '../identity/principal';
import { bearerChallenge, bearerToken, missingCredential } from '../identity/resource-metadata';
import { JWTService } from '../auth/jwt';
import { accessToken } from '@semiont/core';

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
        // `principal`, which is correct — nothing about the holder is known
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
        c.header('WWW-Authenticate', bearerChallenge(c, 'invalid_token'));
        return c.json({ error: 'Invalid media token' }, 401);
      }
    }
  }

  const tokenStr = bearerToken(c.req.header('Authorization'));

  if (!tokenStr) {
    logger.warn('Authentication failed: No token', {
      type: 'auth_failed',
      reason: 'missing_token',
      path: c.req.path,
      method: c.req.method
    });
    return missingCredential(c);
  }

  try {
    const principal = await principalFromToken(accessToken(tokenStr));

    c.set('principal', principal);

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
