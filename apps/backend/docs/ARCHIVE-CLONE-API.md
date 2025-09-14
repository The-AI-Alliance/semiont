# Archive and Clone API Documentation

## Overview

Backend implementation for document archiving and cloning functionality. These features enable document preservation and version management.

## Archive Feature

### Database Schema

The archive functionality is implemented through a boolean field on the Document entity:

```typescript
interface Document {
  id: string;
  name: string;
  content: string;
  archived?: boolean;  // Optional, defaults to false
  // ... other fields
}
```

### API Endpoint

#### Update Document (Including Archive Status)

**Endpoint**: `PUT /api/documents/:id`

**Request Body**:
```json
{
  "archived": true  // or false to unarchive
}
```

**Response**: Updated document object

**Implementation** (`/routes/documents.ts`):
```typescript
if (body.archived !== undefined) {
  updateInput.archived = body.archived;
}
const document = await graphDb.updateDocument(id, updateInput);
```

### Graph Database Integration

The Neptune implementation stores the archived status as a vertex property:

```typescript
// In Neptune implementation
async updateDocument(id: string, input: UpdateDocumentInput) {
  const traversal = this.g.V().has('id', id);
  if (input.archived !== undefined) {
    traversal.property('archived', input.archived);
  }
  // ... other updates
}
```

## Clone Feature

### Architecture

The clone feature uses a token-based approach to avoid circular references and provide secure, time-limited access to source documents.

### Token Management

**In-Memory Storage**:
```typescript
const cloneTokens = new Map<string, {
  sourceDocumentId: string;
  sourceDocument: any;
  content: string;
  selections: any[];
  userId: string;
  expiresAt: Date;
}>();
```

**Automatic Cleanup**:
```typescript
// Clean up expired tokens every minute
setInterval(() => {
  const now = new Date();
  for (const [token, data] of cloneTokens.entries()) {
    if (data.expiresAt < now) {
      cloneTokens.delete(token);
    }
  }
}, 60000);
```

### API Endpoints

#### 1. Generate Clone Token

**Endpoint**: `POST /api/documents/:id/clone`

**Purpose**: Prepares a document for cloning by generating a temporary access token

**Response**:
```json
{
  "token": "clone_1234567890_abc123",
  "expiresAt": "2024-01-01T12:15:00Z",
  "sourceDocument": {
    "id": "doc_123",
    "name": "Original Document",
    "entityTypes": ["Type1", "Type2"]
  }
}
```

**Implementation**:
```typescript
// Generate unique token
const token = `clone_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

// Store document data with token
cloneTokens.set(token, {
  sourceDocumentId: sourceId,
  sourceDocument: sourceDoc,
  content,
  selections: sourceSelections,
  userId: user.id,
  expiresAt
});
```

#### 2. Get Document by Token

**Endpoint**: `GET /api/documents/token/:token`

**Purpose**: Retrieves source document data using a clone token

**Validation**:
- Token must exist
- Token must belong to requesting user
- Token must not be expired

**Response**:
```json
{
  "sourceDocument": { /* document data */ },
  "content": "Document content...",
  "selections": [ /* array of selections */ ],
  "expiresAt": "2024-01-01T12:15:00Z"
}
```

#### 3. Create Document from Token

**Endpoint**: `POST /api/documents/create-from-token`

**Purpose**: Creates a new document using a clone token

**Request Body**:
```json
{
  "token": "clone_1234567890_abc123",
  "name": "Copy of Original Document",
  "content": "Modified content...",
  "archiveOriginal": false  // Optional
}
```

**Process**:
1. Validate token (exists, owned by user, not expired)
2. Delete token (single use)
3. Create new document with provenance tracking
4. Clone all selections from source
5. Optionally archive the original
6. Store document content

**Provenance Tracking**:
```typescript
const createInput = {
  name: body.name,
  entityTypes: tokenData.sourceDocument.entityTypes || [],
  contentType: tokenData.sourceDocument.contentType,
  metadata: {
    clonedFrom: tokenData.sourceDocumentId,
    clonedAt: new Date().toISOString(),
  },
  creationMethod: 'clone',
  sourceDocumentId: tokenData.sourceDocumentId,
};
```

### Selection Cloning

When cloning a document, all highlights and references are copied:

```typescript
for (const sel of tokenData.selections) {
  if (sel.saved || sel.resolvedDocumentId) {
    const cloneInput = {
      documentId: document.id,  // New document ID
      selectionType: sel.selectionType,
      selectionData: sel.selectionData,
      saved: sel.saved,
      savedBy: user.id,
      metadata: {
        clonedFrom: sel.id,  // Track source selection
      },
      // Copy reference data if present
      resolvedDocumentId: sel.resolvedDocumentId,
      referenceTags: sel.referenceTags,
      entityTypes: sel.entityTypes,
      confidence: sel.confidence
    };
    
    await graphDb.createSelection(cloneInput);
  }
}
```

## Security Considerations

### Token Security

1. **User Scoping**: Tokens are tied to the user who created them
```typescript
if (tokenData.userId !== user.id) {
  return c.json({ error: 'Token does not belong to current user' }, 403);
}
```

2. **Time Limitation**: 15-minute expiry window
3. **Single Use**: Token deleted after successful use
4. **Secure Generation**: Combination of timestamp and random string

### Access Control

- Only authenticated users can archive/clone documents
- Users can only clone documents they have access to
- Archive status changes require document ownership

## Error Handling

### Common Error Scenarios

1. **Token Expired**:
```typescript
if (tokenData.expiresAt < new Date()) {
  cloneTokens.delete(token);
  return c.json({ error: 'Token has expired' }, 400);
}
```

2. **Invalid Token**:
```typescript
if (!tokenData) {
  return c.json({ error: 'Invalid or expired token' }, 400);
}
```

3. **Document Not Found**:
```typescript
if (!sourceDoc) {
  return c.json({ error: 'Source document not found' }, 404);
}
```

## Performance Considerations

### Token Storage

Current implementation uses in-memory Map:
- **Pros**: Fast access, simple implementation
- **Cons**: Lost on server restart, not distributed

**Production Recommendation**: Use Redis or similar distributed cache

### Selection Cloning

Selections are cloned sequentially to maintain data integrity:
```typescript
// Current: Sequential for data integrity
for (const sel of selections) {
  await graphDb.createSelection(sel);
}

// Future optimization: Batch creation
await graphDb.createSelections(selections);
```

## Testing Considerations

### Archive Feature Tests
- Toggle archive status
- Verify archived documents are read-only in UI
- Ensure unarchive restores full functionality

### Clone Feature Tests
- Token generation and expiry
- Cross-user token access (should fail)
- Selection preservation
- Provenance tracking
- Archive original option

## Future Enhancements

1. **Distributed Token Storage**: Redis implementation for production
2. **Batch Selection Cloning**: Improve performance for documents with many selections
3. **Clone History**: Track all clones of a document
4. **Merge Changes**: Allow merging changes back to original
5. **Version Comparison**: Show differences between original and clone