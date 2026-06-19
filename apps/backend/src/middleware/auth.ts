import { Context, Next } from 'hono';
import { OAuthService } from '../auth/oauth';
import { JWTService } from '../auth/jwt';
import { User } from '@prisma/client';
import { accessToken, userToDid } from '@semiont/core';

interface Variables {
  user: User;
  token: string;
  /**
   * The DID identifying the authenticated principal — either a Person
   * (computed from the User) or a Software peer (from the JWT's
   * `agentDid` field). Used as `_userId` on bus emits and as the
   * `creator` on resource creation, so callers don't have to know
   * whether the principal is a human or an agent.
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
        // Media tokens are stateless — no user lookup needed; set a sentinel
        c.set('token', mediaTokenParam);
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
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const { user, agentDid } = await OAuthService.getPrincipalFromToken(accessToken(tokenStr));

    // Add user and token to context
    c.set('user', user);
    c.set('token', tokenStr);
    c.set('principalDid', agentDid ?? userToDid(user));

    logger.debug('Authentication successful', {
      type: 'auth_success',
      userId: user.id,
      email: user.email,
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
    return c.json({ error: 'Invalid token' }, 401);
  }
};

export const optionalAuthMiddleware = async (c: Context, next: Next) => {
  const authHeader = c.req.header('Authorization');

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const tokenStr = authHeader.substring(7);

    try {
      const { user, agentDid } = await OAuthService.getPrincipalFromToken(accessToken(tokenStr));
      c.set('user', user);
      c.set('principalDid', agentDid ?? userToDid(user));
    } catch (error) {
      // Ignore auth errors for optional auth
    }
  }

  await next();
};
