import { Context, Next } from 'hono';
import { OAuthService } from '../auth/oauth';
import { User } from '@prisma/client';
import { accessToken } from '@semiont/api-client';

interface Variables {
  user: User;
}

export interface AuthContext extends Context {
  get: <T extends keyof Variables>(key: T) => Variables[T];
  set: <T extends keyof Variables>(key: T, value: Variables[T]) => void;
}

export const authMiddleware = async (c: Context, next: Next): Promise<Response | void> => {
  const logger = c.get('logger');
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn('Authentication failed: Missing Authorization header', {
      type: 'auth_failed',
      reason: 'missing_header',
      path: c.req.path,
      method: c.req.method
    });
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const tokenStr = authHeader.substring(7).trim(); // Remove 'Bearer ' prefix and trim

  if (!tokenStr) {
    logger.warn('Authentication failed: Empty token', {
      type: 'auth_failed',
      reason: 'empty_token',
      path: c.req.path,
      method: c.req.method
    });
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const user = await OAuthService.getUserFromToken(accessToken(tokenStr));

    // Add user to context
    c.set('user', user);

    logger.debug('Authentication successful', {
      type: 'auth_success',
      userId: user.id,
      email: user.email,
      path: c.req.path,
      method: c.req.method
    });

    await next();
    return; // Explicit return for successful case
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
      const user = await OAuthService.getUserFromToken(accessToken(tokenStr));
      c.set('user', user);
    } catch (error) {
      // Ignore auth errors for optional auth
    }
  }

  await next();
};