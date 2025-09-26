import { streamSSE } from 'hono/streaming';
import { HTTPException } from 'hono/http-exception';
import { getGraphDatabase } from '../../../graph/factory';
import { getStorageService } from '../../../storage/filesystem';
import { generateDocumentFromTopic } from '../../../inference/factory';
import { calculateChecksum } from '@semiont/utils';
import type { SelectionsRouterType } from '../shared';
import type { CreateDocumentInput } from '@semiont/core-types';

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
export function registerGenerateDocumentStream(router: SelectionsRouterType) {
  router.post('/api/selections/:id/generate-document-stream', async (c) => {
    const { id: referenceId } = c.req.param();
    const body = await c.req.json() as {
      prompt?: string;
      title?: string;
    };

    // User will be available from auth middleware
    const user = c.get('user');
    if (!user) {
      throw new HTTPException(401, { message: 'Authentication required' });
    }

    console.log(`[GenerateDocument] Starting generation for reference ${referenceId}`);

    // Validate reference exists
    const graphDb = await getGraphDatabase();
    const storage = getStorageService();

    const selection = await graphDb.getSelection(referenceId);
    if (!selection) {
      throw new HTTPException(404, { message: 'Reference not found' });
    }

    // Stream SSE events
    return streamSSE(c, async (stream) => {
      try {
        // Determine document name early
        const documentName = body.title || selection.selectionData?.text || 'New Document';

        // Send initial started event
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

        // Fetch source document
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

        const sourceDocument = await graphDb.getDocument(selection.documentId);
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

        const documentInput: CreateDocumentInput = {
          name: documentName,
          content: generatedContent.content,
          contentType: 'text/markdown',
          contentChecksum: calculateChecksum(generatedContent.content),
          entityTypes: selection.entityTypes || [],
          creationMethod: 'generated',
          sourceDocumentId: selection.documentId,
          metadata: {
            isDraft: true,
            generatedFrom: referenceId
          },
          createdBy: user.id
        };

        const newDocument = await graphDb.createDocument(documentInput);

        // Save the content to storage
        await storage.saveDocument(newDocument.id, Buffer.from(generatedContent.content));

        // Update the selection to point to the new document
        await graphDb.updateSelection(referenceId, {
          resolvedDocumentId: newDocument.id,
          provisional: false
        });

        // Send completion event with the new document ID
        await stream.writeSSE({
          data: JSON.stringify({
            status: 'complete',
            referenceId,
            documentName,
            documentId: newDocument.id,
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