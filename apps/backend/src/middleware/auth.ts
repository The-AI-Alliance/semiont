import { Context, Next } from 'hono';
import { OAuthService } from '../auth/oauth';
import { User } from '@prisma/client';

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

  const token = authHeader.substring(7).trim(); // Remove 'Bearer ' prefix and trim
  
  if (!token) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const user = await OAuthService.getUserFromToken(token);
    
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
    const token = authHeader.substring(7);
    
    try {
      const user = await OAuthService.getUserFromToken(token);
      c.set('user', user);
    } catch (error) {
      // Ignore auth errors for optional auth
    }
  }
  
  await next();
};