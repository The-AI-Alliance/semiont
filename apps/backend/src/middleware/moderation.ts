import { Context, Next } from 'hono';
import { User } from '@prisma/client';

/**
 * Moderation middleware - requires user to be either moderator or admin
 * Must be used after authMiddleware to ensure user is authenticated
 */
export const moderationMiddleware = async (c: Context, next: Next): Promise<Response | void> => {
  const user = c.get('user') as User;
  
  if (!user) {
    return c.json({ error: 'Unauthorized: Authentication required' }, 401);
  }
  
  // Allow access if user is either moderator or admin
  if (!user.isModerator && !user.isAdmin) {
    return c.json({ error: 'Forbidden: Moderator or Admin access required' }, 403);
  }
  
  await next();
};

/**
 * Strict moderation middleware - requires user to be moderator (not just admin)
 * Use this for actions that should be moderator-specific
 */
export const strictModerationMiddleware = async (c: Context, next: Next): Promise<Response | void> => {
  const user = c.get('user') as User;
  
  if (!user) {
    return c.json({ error: 'Unauthorized: Authentication required' }, 401);
  }
  
  if (!user.isModerator) {
    return c.json({ error: 'Forbidden: Moderator access required' }, 403);
  }
  
  await next();
};