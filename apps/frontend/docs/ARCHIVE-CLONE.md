# Archive and Clone Features

> **⚠️ Note:** Code examples in this document use the old `apiService.*` pattern. The current architecture uses React Query hooks (`api.*`). See [ARCHITECTURE.md](./ARCHITECTURE.md) and [AUTHENTICATION.md](./AUTHENTICATION.md) for current patterns.

## Overview

The Archive and Clone features provide document lifecycle management capabilities, allowing users to preserve important documents and create working copies.

## Archive Feature

### Purpose
The Archive feature makes a document read-only to prevent accidental modifications while preserving all existing annotations (highlights and references).

### User Interface

Located in the "Manage" section of the document sidebar:

```tsx
// Location: /app/know/document/[id]/page.tsx
<button onClick={handleArchive}>
  {document.archived ? 'Unarchive' : 'Archive'}
</button>
```

### Behavior

When a document is archived:
- **Visual indicator**: "Archived" badge appears in the Manage section
- **Text selection disabled**: No sparkle appears, can't create new highlights/references
- **Annotation interaction**: 
  - Existing annotations remain visible
  - Click navigation still works for references
  - Right-click menu is disabled
- **Document tags disabled**: Cannot add or remove entity types
- **Reversible**: Can be unarchived at any time

### Implementation Details

```typescript
// API call to toggle archive status
await apiService.documents.update(documentId, {
  archived: !document.archived
});

// Conditional rendering based on archive status
<AnnotationRenderer
  {...(!document.archived && { 
    onTextSelect: handleTextSelection,
    onAnnotationRightClick: handleAnnotationRightClick
  })}
/>
```

## Clone Feature

### Purpose
Creates an editable copy of a document, preserving the original while allowing modifications to the copy. Maintains provenance tracking.

### User Interface

Located in the "Manage" section below the Archive button:

```tsx
<button onClick={handleClone}>Clone</button>
```

### Workflow

1. **Initiate Clone**: User clicks "Clone" button
2. **Token Generation**: Backend creates temporary token (15-minute expiry)
3. **Redirect**: User redirected to `/know/create?mode=clone&token=xxx`
4. **Edit Copy**: Create page loads source document for editing
5. **Save**: Creates new document with provenance link

### Token-Based Architecture

The clone process uses a secure token mechanism:

```typescript
// Step 1: Generate clone token
const response = await apiService.documents.clone(documentId);
// Returns: { token: string, expiresAt: string }

// Step 2: Redirect with token
router.push(`/know/create?mode=clone&token=${response.token}`);

// Step 3: Fetch source document using token
const sourceData = await apiService.documents.getByToken(token);

// Step 4: Create new document from token
await apiService.documents.createFromToken({
  token,
  name: editedName,
  content: editedContent,
  archiveOriginal: false // optional
});
```

### Provenance Tracking

Cloned documents maintain a link to their source:

```tsx
// Displayed in sidebar for cloned documents
{document.sourceDocumentId && document.creationMethod === 'clone' && (
  <div className="provenance-section">
    <span>Cloned from: </span>
    <Link href={`/know/document/${document.sourceDocumentId}`}>
      {sourceDocumentName}
    </Link>
  </div>
)}
```

### Selection Preservation

All highlights and references from the source document are copied to the clone:
- Maintains same text positions
- Preserves reference links
- Copies metadata and tags
- Each selection tracks its cloned origin

## Combined Workflow Example

Common use case: Archive and Clone

1. User completes work on a document
2. Archives the document to preserve it
3. Later needs to make changes
4. Clones the archived document
5. Works on the clone
6. Original remains safely archived

## API Endpoints Used

### Archive
- `PUT /api/documents/:id` - Update document with `archived` field

### Clone
- `POST /api/documents/:id/clone` - Generate clone token
- `GET /api/documents/token/:token` - Fetch source document via token
- `POST /api/documents/create-from-token` - Create new document from clone

## State Management

Both features update local state immediately after API calls:

```typescript
// Reload document after archive toggle
await loadDocument();

// Clone redirects to new page, no local state update needed
router.push(`/know/create?mode=clone&token=${token}`);
```

## Error Handling

- **Archive**: Shows alert on failure, document state unchanged
- **Clone Token Expiry**: Returns error if token expired (15 minutes)
- **Clone Token Invalid**: Returns error if token doesn't exist or belongs to another user

## Security Considerations

1. **Archive**: Only document owner can archive/unarchive
2. **Clone Tokens**: 
   - Single use (deleted after use)
   - Time-limited (15 minutes)
   - User-scoped (can't use another user's token)
   - Stored in memory (cleared on server restart)