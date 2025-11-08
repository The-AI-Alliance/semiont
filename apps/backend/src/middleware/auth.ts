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
  const authHeader = c.req.header('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const tokenStr = authHeader.substring(7).trim(); // Remove 'Bearer ' prefix and trim

  if (!tokenStr) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const user = await OAuthService.getUserFromToken(accessToken(tokenStr));
    
    // Add user to context
    c.set('user', user);
    
    await next();
    return; // Explicit return for successful case
  } catch (error) {
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