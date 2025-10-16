import { z } from 'zod';

/**
 * Add Entity Type Response
 */
export const AddEntityTypeResponseSchema = z.object({
  success: z.boolean(),
  entityTypes: z.array(z.string()),
});

export type AddEntityTypeResponse = z.infer<typeof AddEntityTypeResponseSchema>;
