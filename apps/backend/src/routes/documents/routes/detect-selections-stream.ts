import { streamSSE } from 'hono/streaming';
import { HTTPException } from 'hono/http-exception';
import { getGraphDatabase } from '../../../graph/factory';
import { getStorageService } from '../../../storage/filesystem';
import { detectSelectionsInDocument } from '../helpers';
import type { CreateSelectionInput } from '@semiont/core-types';
import type { DocumentsRouterType } from '../shared';

interface DetectionProgress {
  status: 'started' | 'scanning' | 'creating' | 'complete' | 'error';
  documentId: string;
  currentEntityType?: string;
  totalEntityTypes: number;
  processedEntityTypes: number;
  foundCount: number;
  createdCount: number;
  percentage: number;
  message?: string;
}

/**
 * SSE endpoint for real-time detection progress updates
 */
export function registerDetectSelectionsStream(router: DocumentsRouterType) {
  router.post('/api/documents/:id/detect-selections-stream', async (c) => {
    const { id } = c.req.param();
    const body = await c.req.json() as { entityTypes: string[] };
    const entityTypes = body.entityTypes || [];

    console.log(`[DetectSelections] Starting detection for document ${id} with entity types:`, entityTypes);

    // User will be available from auth middleware since this is a POST request
    const user = c.get('user');
    if (!user) {
      throw new HTTPException(401, { message: 'Authentication required' });
    }

    // Validate document exists
    const graphDb = await getGraphDatabase();
    const storage = getStorageService();

    const document = await graphDb.getDocument(id);
    if (!document) {
      throw new HTTPException(404, { message: 'Document not found' });
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
            foundCount: 0,
            createdCount: 0,
            percentage: 0,
            message: 'Starting entity detection...'
          } as DetectionProgress),
          event: 'detection-started',
          id: String(Date.now())
        });

        // Get document content
        const content = await storage.getDocument(id);
        const docWithContent = { ...document, content: content.toString('utf-8') };

        let totalFound = 0;
        let totalCreated = 0;

        // Process each entity type
        for (let i = 0; i < entityTypes.length; i++) {
          const entityType = entityTypes[i];
          if (!entityType) continue; // Skip if undefined
          const percentage = Math.floor((i / entityTypes.length) * 80); // Reserve 20% for saving

          // Send scanning progress
          await stream.writeSSE({
            data: JSON.stringify({
              status: 'scanning',
              documentId: id,
              currentEntityType: entityType,
              totalEntityTypes: entityTypes.length,
              processedEntityTypes: i,
              foundCount: totalFound,
              createdCount: totalCreated,
              percentage,
              message: `Scanning for ${entityType} entities...`
            } as DetectionProgress),
            event: 'detection-progress',
            id: String(Date.now())
          });

          // Detect selections for this entity type
          const detectedSelections = await detectSelectionsInDocument(
            docWithContent,
            [entityType]
          );

          totalFound += detectedSelections.length;

          // Save the provisional selections
          for (const detected of detectedSelections) {
            const selectionInput: CreateSelectionInput & { selectionType: string } = {
              documentId: id,
              selectionType: 'reference',
              selectionData: detected.selection.selectionData,
              resolvedDocumentId: null,
              entityTypes: detected.selection.entityTypes,
              metadata: detected.selection.metadata,
              createdBy: user.id,
            };

            await graphDb.createSelection(selectionInput);
            totalCreated++;

            // Send creation progress
            const creationPercentage = 80 + Math.floor((totalCreated / totalFound) * 20);
            await stream.writeSSE({
              data: JSON.stringify({
                status: 'creating',
                documentId: id,
                currentEntityType: entityType,
                totalEntityTypes: entityTypes.length,
                processedEntityTypes: i + 1,
                foundCount: totalFound,
                createdCount: totalCreated,
                percentage: creationPercentage,
                message: `Creating reference ${totalCreated} of ${totalFound}...`
              } as DetectionProgress),
              event: 'reference-created',
              id: String(Date.now())
            });
          }
        }

        // Send completion event
        await stream.writeSSE({
          data: JSON.stringify({
            status: 'complete',
            documentId: id,
            totalEntityTypes: entityTypes.length,
            processedEntityTypes: entityTypes.length,
            foundCount: totalFound,
            createdCount: totalCreated,
            percentage: 100,
            message: `Detection complete! Created ${totalCreated} entity references.`
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
            foundCount: 0,
            createdCount: 0,
            percentage: 0,
            message: error instanceof Error ? error.message : 'Detection failed'
          } as DetectionProgress),
          event: 'detection-error',
          id: String(Date.now())
        });
      }
    });
  });
}