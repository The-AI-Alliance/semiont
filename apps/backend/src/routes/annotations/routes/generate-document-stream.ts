import { createRoute, z } from '@hono/zod-openapi';
import { streamSSE } from 'hono/streaming';
import { HTTPException } from 'hono/http-exception';
import { getStorageService } from '../../../storage/filesystem';
import { generateDocumentFromTopic } from '../../../inference/factory';
import { calculateChecksum } from '@semiont/utils';
import type { AnnotationsRouterType } from '../shared';
import { AnnotationQueryService } from '../../../services/annotation-queries';
import { DocumentQueryService } from '../../../services/document-queries';
import { emitDocumentCreated, emitReferenceResolved } from '../../../events/emit';

interface GenerationProgress {
  status: 'started' | 'fetching' | 'generating' | 'creating' | 'complete' | 'error';
  referenceId: string;
  documentName?: string;
  documentId?: string;
  sourceDocumentId?: string;
  percentage: number;
  message?: string;
}

/**
 * SSE endpoint for real-time document generation progress updates
 */
export const generateDocumentStreamRoute = createRoute({
  method: 'post',
  path: '/api/selections/{id}/generate-document-stream',
  summary: 'Generate Document from Reference (SSE)',
  description: 'Stream real-time document generation progress via Server-Sent Events',
  tags: ['Selections', 'Documents', 'Real-time', 'AI'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().describe('Reference/selection ID'),
    }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            documentId: z.string().describe('Document ID containing the reference'),
            title: z.string().optional().describe('Custom title for generated document'),
            prompt: z.string().optional().describe('Custom prompt for content generation'),
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
      description: 'Reference not found',
    },
  },
});

export function registerGenerateDocumentStream(router: AnnotationsRouterType) {
  router.openapi(generateDocumentStreamRoute, async (c) => {
    const { id: referenceId } = c.req.valid('param');
    const body = c.req.valid('json');

    // User will be available from auth middleware
    const user = c.get('user');
    if (!user) {
      throw new HTTPException(401, { message: 'Authentication required' });
    }

    console.log(`[GenerateDocument] Starting generation for reference ${referenceId} in document ${body.documentId}`);

    // Validate reference exists using Layer 3 - O(1) lookup since we know the document
    const storage = getStorageService();
    const projection = await AnnotationQueryService.getDocumentAnnotations(body.documentId);

    // Find the reference in this document's annotations
    const reference = projection.references.find((r: any) => r.id === referenceId);
    if (!reference) {
      throw new HTTPException(404, { message: 'Reference not found in document' });
    }

    const selection = {
      id: reference.id,
      documentId: body.documentId,
      text: reference.text,
      position: reference.position,
      type: 'reference' as const,
      targetDocumentId: reference.targetDocumentId,
      entityTypes: reference.entityTypes,
    };

    // Stream SSE events
    return streamSSE(c, async (stream) => {
      try {
        // Determine document name early
        const documentName = body.title || selection.text || 'New Document';

        // Send initial started event
        console.log('[SSE] Sending generation-started event');
        await stream.writeSSE({
          data: JSON.stringify({
            status: 'started',
            referenceId,
            documentName,
            percentage: 0,
            message: 'Starting...'
          } as GenerationProgress),
          event: 'generation-started',
          id: String(Date.now())
        });
        console.log('[SSE] generation-started event sent');

        // Fetch source document from Layer 3
        await stream.writeSSE({
          data: JSON.stringify({
            status: 'fetching',
            referenceId,
            documentName,
            percentage: 20,
            message: 'Fetching source document...'
          } as GenerationProgress),
          event: 'generation-progress',
          id: String(Date.now())
        });

        const sourceDocument = await DocumentQueryService.getDocumentMetadata(selection.documentId);
        if (!sourceDocument) {
          throw new Error('Source document not found');
        }

        // Generate content
        const prompt = body.prompt || `Create a comprehensive document about "${documentName}"`;
        await stream.writeSSE({
          data: JSON.stringify({
            status: 'generating',
            referenceId,
            documentName,
            percentage: 40,
            message: 'Creating content...'
          } as GenerationProgress),
          event: 'generation-progress',
          id: String(Date.now())
        });

        // Generate document content using existing function
        const generatedContent = await generateDocumentFromTopic(
          documentName,
          selection.entityTypes || [],
          prompt
        );

        await stream.writeSSE({
          data: JSON.stringify({
            status: 'generating',
            referenceId,
            documentName,
            percentage: 70,
            message: 'Content ready, saving draft...'
          } as GenerationProgress),
          event: 'generation-progress',
          id: String(Date.now())
        });

        // Create the document as a draft
        await stream.writeSSE({
          data: JSON.stringify({
            status: 'creating',
            referenceId,
            documentName,
            percentage: 85,
            message: 'Saving draft document...'
          } as GenerationProgress),
          event: 'generation-progress',
          id: String(Date.now())
        });

        const checksum = calculateChecksum(generatedContent.content);
        const documentId = `doc-sha256:${checksum}`;

        // Save content to Layer 1 (filesystem)
        await storage.saveDocument(documentId, Buffer.from(generatedContent.content));

        // Emit document.created event (event store updates Layer 3, graph consumer updates Layer 4)
        await emitDocumentCreated({
          documentId,
          userId: user.id,
          name: documentName,
          contentType: 'text/markdown',
          contentHash: checksum,
          entityTypes: selection.entityTypes || [],
          metadata: {
            isDraft: true,
            generatedFrom: referenceId,
          },
        });

        // Emit reference.resolved event to link the reference to the new document
        await emitReferenceResolved({
          documentId: selection.documentId,
          referenceId,
          userId: user.id,
          targetDocumentId: documentId,
        });

        // Send completion event with the new document ID
        await stream.writeSSE({
          data: JSON.stringify({
            status: 'complete',
            referenceId,
            documentName,
            documentId,
            sourceDocumentId: selection.documentId,
            percentage: 100,
            message: 'Draft document created! Ready for review.'
          } as GenerationProgress),
          event: 'generation-complete',
          id: String(Date.now())
        });

      } catch (error) {
        // Send error event
        await stream.writeSSE({
          data: JSON.stringify({
            status: 'error',
            referenceId,
            percentage: 0,
            message: error instanceof Error ? error.message : 'Generation failed'
          } as GenerationProgress),
          event: 'generation-error',
          id: String(Date.now())
        });
      }
    });
  });
}