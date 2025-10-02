import { createRoute, z } from '@hono/zod-openapi';
import { streamSSE } from 'hono/streaming';
import { HTTPException } from 'hono/http-exception';
import { getStorageService } from '../../../storage/filesystem';
import { detectSelectionsInDocument } from '../helpers';
import type { DocumentsRouterType } from '../shared';
import { DocumentQueryService } from '../../../services/document-queries';
import { emitReferenceCreated } from '../../../events/emit';
import { generateAnnotationId } from '../../../utils/id-generator';

interface DetectionProgress {
  status: 'started' | 'scanning' | 'complete' | 'error';
  documentId: string;
  currentEntityType?: string;
  totalEntityTypes: number;
  processedEntityTypes: number;
  message?: string;
}

/**
 * SSE endpoint for real-time detection progress updates
 */
export const detectSelectionsStreamRoute = createRoute({
  method: 'post',
  path: '/api/documents/{id}/detect-selections-stream',
  summary: 'Detect Selections with Progress (SSE)',
  description: 'Stream real-time entity detection progress via Server-Sent Events',
  tags: ['Documents', 'Selections', 'Real-time'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            entityTypes: z.array(z.string()),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'SSE stream opened successfully',
      content: {
        'text/event-stream': {
          schema: z.object({
            event: z.string(),
            data: z.string(),
            id: z.string().optional(),
          }),
        },
      },
    },
    401: {
      description: 'Authentication required',
    },
    404: {
      description: 'Document not found',
    },
  },
});

export function registerDetectSelectionsStream(router: DocumentsRouterType) {
  router.openapi(detectSelectionsStreamRoute, async (c) => {
    const { id } = c.req.valid('param');
    const { entityTypes } = c.req.valid('json');

    console.log(`[DetectSelections] Starting detection for document ${id} with entity types:`, entityTypes);

    // User will be available from auth middleware since this is a POST request
    const user = c.get('user');
    if (!user) {
      throw new HTTPException(401, { message: 'Authentication required' });
    }

    // Validate document exists using Layer 3
    const storage = getStorageService();

    const document = await DocumentQueryService.getDocumentMetadata(id);
    if (!document) {
      throw new HTTPException(404, { message: 'Document not found in Layer 3 projections - document may need to be recreated' });
    }

    // Stream SSE events
    return streamSSE(c, async (stream) => {
      try {
        // Send initial started event
        await stream.writeSSE({
          data: JSON.stringify({
            status: 'started',
            documentId: id,
            totalEntityTypes: entityTypes.length,
            processedEntityTypes: 0,
            message: 'Starting entity detection...'
          } as DetectionProgress),
          event: 'detection-started',
          id: String(Date.now())
        });

        // Get document content
        const content = await storage.getDocument(id);
        const docWithContent = { ...document, content: content.toString('utf-8') };

        // Process each entity type
        for (let i = 0; i < entityTypes.length; i++) {
          const entityType = entityTypes[i];
          if (!entityType) continue; // Skip if undefined

          // Send scanning progress for this entity type
          await stream.writeSSE({
            data: JSON.stringify({
              status: 'scanning',
              documentId: id,
              currentEntityType: entityType,
              totalEntityTypes: entityTypes.length,
              processedEntityTypes: i,
              message: `Scanning for ${entityType}...`
            } as DetectionProgress),
            event: 'detection-progress',
            id: String(Date.now())
          });

          // Detect selections for this entity type
          const detectedSelections = await detectSelectionsInDocument(
            docWithContent,
            [entityType]
          );

          // Create provisional references via events (event store updates Layer 3, graph consumer updates Layer 4)
          // References will appear in Annotation History as they're created (via debounced refetch)
          for (const detected of detectedSelections) {
            const referenceId = generateAnnotationId();

            await emitReferenceCreated({
              documentId: id,
              userId: user.id,
              referenceId,
              text: detected.selection.selectionData.text,
              position: {
                offset: detected.selection.selectionData.offset,
                length: detected.selection.selectionData.length,
              },
              entityTypes: detected.selection.entityTypes,
              referenceType: undefined, // Unresolved reference
              targetDocumentId: undefined, // Will be resolved later
            });
          }

          // Update progress after completing this entity type
          await stream.writeSSE({
            data: JSON.stringify({
              status: 'scanning',
              documentId: id,
              currentEntityType: entityType,
              totalEntityTypes: entityTypes.length,
              processedEntityTypes: i + 1,
              message: `Completed ${entityType}`
            } as DetectionProgress),
            event: 'detection-progress',
            id: String(Date.now())
          });
        }

        // Send completion event
        await stream.writeSSE({
          data: JSON.stringify({
            status: 'complete',
            documentId: id,
            totalEntityTypes: entityTypes.length,
            processedEntityTypes: entityTypes.length,
            message: 'Detection complete!'
          } as DetectionProgress),
          event: 'detection-complete',
          id: String(Date.now())
        });

      } catch (error) {
        // Send error event
        await stream.writeSSE({
          data: JSON.stringify({
            status: 'error',
            documentId: id,
            totalEntityTypes: entityTypes.length,
            processedEntityTypes: 0,
            message: error instanceof Error ? error.message : 'Detection failed'
          } as DetectionProgress),
          event: 'detection-error',
          id: String(Date.now())
        });
      }
    });
  });
}
