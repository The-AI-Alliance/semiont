import { z } from 'zod';

/**
 * Google Auth Request - OAuth access token for login
 */
export const GoogleAuthRequestSchema = z.object({
  access_token: z.string(),
});

export type GoogleAuthRequest = z.infer<typeof GoogleAuthRequestSchema>;
