import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { createSelectionRouter, type SelectionsRouterType } from './shared';
import { formatDocument, formatDocumentWithContent, formatSelection } from './helpers';
import { getGraphDatabase } from '../../graph/factory';
import { getStorageService } from '../../storage/filesystem';
import { generateDocumentFromTopic, generateText } from '../../inference/factory';
import { calculateChecksum } from '@semiont/utils';
import { CREATION_METHODS } from '@semiont/core-types';
import type { CreateDocumentInput } from '@semiont/core-types';
import { registerGenerateDocumentStream } from './routes/generate-document-stream';

// Create router with auth middleware
export const operationsRouter: SelectionsRouterType = createSelectionRouter();

// Local schemas
const CreateDocumentFromSelectionRequest = z.object({
  name: z.string().min(1).max(255),
  entityTypes: z.array(z.string()).optional(),
  content: z.string().optional(),
  contentType: z.string().default('text/plain'),
  metadata: z.record(z.string(), z.any()).optional(),
});

const CreateDocumentFromSelectionResponse = z.object({
  document: z.any(),
  selection: z.any(),
});

const GenerateDocumentFromSelectionRequest = z.object({
  name: z.string().min(1).max(255).optional(),
  entityTypes: z.array(z.string()).optional(),
  prompt: z.string().optional(),
});

const GenerateDocumentFromSelectionResponse = z.object({
  document: z.any(),
  selection: z.any(),
  generated: z.boolean(),
});

const SelectionContextResponse = z.object({
  selection: z.any(),
  context: z.object({
    before: z.string().optional(),
    selected: z.string(),
    after: z.string().optional(),
  }),
  document: z.any(),
});

const ContextualSummaryResponse = z.object({
  summary: z.string(),
  relevantFields: z.record(z.string(), z.any()),
  context: z.object({
    before: z.string().optional(),
    selected: z.string(),
    after: z.string().optional(),
  }),
});

// CREATE DOCUMENT FROM SELECTION
const createDocumentFromSelectionRoute = createRoute({
  method: 'post',
  path: '/api/selections/{id}/create-document',
  summary: 'Create Document from Selection',
  description: 'Create a new document from a selection and resolve the selection to it',
  tags: ['Selections'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
    body: {
      content: {
        'application/json': {
          schema: CreateDocumentFromSelectionRequest,
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: CreateDocumentFromSelectionResponse,
        },
      },
      description: 'Document created and selection resolved',
    },
  },
});

operationsRouter.openapi(createDocumentFromSelectionRoute, async (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const user = c.get('user');
  const graphDb = await getGraphDatabase();
  const storage = getStorageService();

  const selection = await graphDb.getSelection(id);
  if (!selection) {
    throw new HTTPException(404, { message: 'Selection not found' });
  }

  // Create the new document
  const checksum = calculateChecksum(body.content || '');
  const documentId = `doc-sha256:${checksum}`;

  const createDocInput: CreateDocumentInput & { id: string } = {
    id: documentId,
    name: body.name,
    content: body.content || '',
    contentType: body.contentType,
    contentChecksum: checksum,
    createdBy: user.id,
    entityTypes: body.entityTypes || [],
    metadata: body.metadata || {},
    creationMethod: CREATION_METHODS.API,
  };

  const document = await graphDb.createDocument(createDocInput);

  // Store content if provided
  if (body.content) {
    await storage.saveDocument(documentId, Buffer.from(body.content));
  }

  // Resolve the selection to the new document
  const updatedSelection = await graphDb.resolveSelection({
    selectionId: id,
    documentId: document.id,
    resolvedBy: user.id,
  });

  if (!body.content) {
    throw new HTTPException(400, { message: 'Content is required when creating a document' });
  }

  return c.json({
    document: formatDocumentWithContent(document, body.content),
    selection: formatSelection(updatedSelection),
  }, 201);
});

// GENERATE DOCUMENT FROM SELECTION
const generateDocumentFromSelectionRoute = createRoute({
  method: 'post',
  path: '/api/selections/{id}/generate-document',
  summary: 'Generate Document from Selection',
  description: 'Use AI to generate document content from a selection',
  tags: ['Selections'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
    body: {
      content: {
        'application/json': {
          schema: GenerateDocumentFromSelectionRequest,
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: GenerateDocumentFromSelectionResponse,
        },
      },
      description: 'Document generated and selection resolved',
    },
  },
});

operationsRouter.openapi(generateDocumentFromSelectionRoute, async (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const user = c.get('user');
  const graphDb = await getGraphDatabase();
  const storage = getStorageService();

  const selection = await graphDb.getSelection(id);
  if (!selection) {
    throw new HTTPException(404, { message: 'Selection not found' });
  }

  // Get the original document content for context
  const originalDoc = await graphDb.getDocument(selection.documentId);
  if (!originalDoc) {
    throw new HTTPException(404, { message: 'Original document not found' });
  }

  // Extract selection text from selectionData
  const data = selection.selectionData as any;

  if (!data || !data.text) {
    throw new HTTPException(400, { message: 'Selection must have text field in selectionData' });
  }

  const selectedText = data.text;

  // Generate content using the proper document generation function
  const { title, content: generatedContent } = await generateDocumentFromTopic(
    selectedText,
    body.entityTypes || selection.entityTypes || [],
    body.prompt
  );

  if (!generatedContent) {
    throw new HTTPException(500, { message: 'No content returned from generation service' });
  }

  // Create the new document
  const documentName = body.name || title;
  const checksum = calculateChecksum(generatedContent);
  const documentId = `doc-sha256:${checksum}`;

  const createDocInput: CreateDocumentInput & { id: string } = {
    id: documentId,
    name: documentName,
    content: generatedContent,
    contentType: 'text/markdown',
    contentChecksum: checksum,
    createdBy: user.id,
    entityTypes: body.entityTypes || selection.entityTypes || [],
    metadata: {
      generatedFrom: selection.id,
      prompt: body.prompt,
    },
    creationMethod: CREATION_METHODS.GENERATED,
  };

  const document = await graphDb.createDocument(createDocInput);

  // Store generated content
  await storage.saveDocument(documentId, Buffer.from(generatedContent));

  // Resolve the selection to the new document
  const updatedSelection = await graphDb.resolveSelection({
    selectionId: id,
    documentId: document.id,
    resolvedBy: user.id,
  });

  return c.json({
    document: formatDocumentWithContent(document, generatedContent),
    selection: formatSelection(updatedSelection),
    generated: true,
  }, 201);
});

// GET SELECTION CONTEXT
const getSelectionContextRoute = createRoute({
  method: 'get',
  path: '/api/selections/{id}/context',
  summary: 'Get Selection Context',
  description: 'Get the context around a selection',
  tags: ['Selections'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
    query: z.object({
      contextBefore: z.coerce.number().int().min(0).max(5000).default(100),
      contextAfter: z.coerce.number().int().min(0).max(5000).default(100),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: SelectionContextResponse,
        },
      },
      description: 'Selection context',
    },
  },
});

operationsRouter.openapi(getSelectionContextRoute, async (c) => {
  const { id } = c.req.valid('param');
  const { contextBefore, contextAfter } = c.req.valid('query');
  const graphDb = await getGraphDatabase();
  const storage = getStorageService();

  const selection = await graphDb.getSelection(id);
  if (!selection) {
    throw new HTTPException(404, { message: 'Selection not found' });
  }

  const document = await graphDb.getDocument(selection.documentId);
  if (!document) {
    throw new HTTPException(404, { message: 'Document not found' });
  }

  const content = await storage.getDocument(selection.documentId);
  const contentStr = content.toString('utf-8');

  // Extract context based on selection type
  let before = '';
  let selected = '';
  let after = '';

  // Check if this is a highlight (no resolvedDocumentId field)
  if (selection.resolvedDocumentId === undefined && selection.selectionData) {
    const data = selection.selectionData as any;
    if (data.offset !== undefined && data.length !== undefined) {
      const selStart = data.offset;
      const selEnd = data.offset + data.length;
      const start = Math.max(0, selStart - contextBefore);
      const end = Math.min(contentStr.length, selEnd + contextAfter);

      before = contentStr.substring(start, selStart);
      selected = contentStr.substring(selStart, selEnd);
      after = contentStr.substring(selEnd, end);
    } else if (data.text) {
      selected = data.text;
      // Try to find the text in the content
      const index = contentStr.indexOf(data.text);
      if (index !== -1) {
        const start = Math.max(0, index - contextBefore);
        const end = Math.min(contentStr.length, index + data.text.length + contextAfter);
        before = contentStr.substring(start, index);
        after = contentStr.substring(index + data.text.length, end);
      }
    }
  }

  return c.json({
    selection: formatSelection(selection),
    context: {
      before,
      selected,
      after,
    },
    document: formatDocument(document),
  });
});

// GET CONTEXTUAL SUMMARY
const getContextualSummaryRoute = createRoute({
  method: 'get',
  path: '/api/selections/{id}/summary',
  summary: 'Get Contextual Summary',
  description: 'Get an AI-generated summary of the selection in context',
  tags: ['Selections'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: ContextualSummaryResponse,
        },
      },
      description: 'Contextual summary',
    },
  },
});

operationsRouter.openapi(getContextualSummaryRoute, async (c) => {
  const { id } = c.req.valid('param');
  const graphDb = await getGraphDatabase();
  const storage = getStorageService();

  const selection = await graphDb.getSelection(id);
  if (!selection) {
    throw new HTTPException(404, { message: 'Selection not found' });
  }

  const document = await graphDb.getDocument(selection.documentId);
  if (!document) {
    throw new HTTPException(404, { message: 'Document not found' });
  }

  const content = await storage.getDocument(selection.documentId);
  const contentStr = content.toString('utf-8');

  // Extract selection text with context
  let before = '';
  let selected = '';
  let after = '';
  const contextSize = 500; // Fixed context for summary

  // Check if this is a highlight (no resolvedDocumentId field)
  if (selection.resolvedDocumentId === undefined && selection.selectionData) {
    const data = selection.selectionData as any;
    if (data.offset !== undefined && data.length !== undefined) {
      const selStart = data.offset;
      const selEnd = data.offset + data.length;
      const start = Math.max(0, selStart - contextSize);
      const end = Math.min(contentStr.length, selEnd + contextSize);

      before = contentStr.substring(start, selStart);
      selected = contentStr.substring(selStart, selEnd);
      after = contentStr.substring(selEnd, end);
    } else if (data.text) {
      selected = data.text;
      const index = contentStr.indexOf(data.text);
      if (index !== -1) {
        const start = Math.max(0, index - contextSize);
        const end = Math.min(contentStr.length, index + data.text.length + contextSize);
        before = contentStr.substring(start, index);
        after = contentStr.substring(index + data.text.length, end);
      }
    }
  }

  // Generate summary using the proper inference function
  const summaryPrompt = `Summarize this text in context:

Context before: "${before.substring(Math.max(0, before.length - 200))}"
Selected text: "${selected}"
Context after: "${after.substring(0, 200)}"

Document: ${document.name}
Entity types: ${(selection.entityTypes || []).join(', ')}`;

  const summary = await generateText(summaryPrompt, 500, 0.5);

  return c.json({
    summary,
    relevantFields: {
      documentId: document.id,
      documentName: document.name,
      entityTypes: selection.entityTypes || [],
    },
    context: {
      before: before.substring(Math.max(0, before.length - 200)), // Last 200 chars
      selected,
      after: after.substring(0, 200), // First 200 chars
    },
  });
});

// Register SSE route for document generation progress
registerGenerateDocumentStream(operationsRouter);