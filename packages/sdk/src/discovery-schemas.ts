import { z } from 'zod';

import { DocumentSchema } from './document-schemas';

/**
 * Discover Context Response
 */
export const DiscoverContextResponseSchema = z.object({
  documents: z.array(DocumentSchema),
  connections: z.array(z.object({
    fromId: z.string(),
    toId: z.string(),
    type: z.string(),
    metadata: z.record(z.string(), z.any()),
  })),
});

export type DiscoverContextResponse = z.infer<typeof DiscoverContextResponseSchema>;

/**
 * Contextual Summary Response
 */
export const ContextualSummaryResponseSchema = z.object({
  summary: z.string(),
  relevantFields: z.record(z.string(), z.any()),
  context: z.object({
    before: z.string().optional(),
    selected: z.string(),
    after: z.string().optional(),
  }),
});

export type ContextualSummaryResponse = z.infer<typeof ContextualSummaryResponseSchema>;
