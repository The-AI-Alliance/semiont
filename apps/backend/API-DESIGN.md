# API Design

Think of Semiont as a Wiki with semantic knowledge capabilities.

## Core Concepts and Terminology

### Documents

- Primary content containers (text, code, images, audio, etc.)
- Can be tagged with **entity types** (e.g., "Person", "Company", "Technology", "Concept")
- Stored with metadata in graph database and content in filesystem

### Selections

- Pointers to specific locations within documents
- Always persisted when created via API (ephemeral selections only exist in UI)
- Types of selections:
  - **Text spans**: Character offset + length in text documents
  - **AST nodes**: Parse tree traversal paths in code
  - **Image regions**: Bounding boxes or shapes in images
  - **Audio segments**: Time offset + duration in audio

### Highlights (Saved Selections)

- When a selection has `saved = true`, it's considered a **highlight**
- Intended for long-term preservation (bookmarks, important content)
- Can be retrieved, updated, or deleted by users

### References (Resolved Selections)

- When a selection has `resolvedDocumentId` set, it becomes a **reference**
- Can have **reference tags** that indicate the semantic relationship type
- Creates edges in the knowledge graph with semantic meaning
- Enables navigation between related documents

### Entity References

- Special type of reference where:
  - The target document has entity type tags
  - The reference specifies which entity types it's referencing
- Example: A selection referencing a "Person" entity in a document about "Albert Einstein"

## API Endpoints

### Document Operations

- `POST /api/documents` - Create document with initial selections
- `GET /api/documents/:id` - Get document with its selections, highlights, and references
- `PUT /api/documents/:id` - Update document metadata
- `DELETE /api/documents/:id` - Delete document
- `GET /api/documents` - List/search documents
- `POST /api/documents/:id/detect-selections` - Auto-detect selections using AI

### Selection Operations

- `POST /api/selections` - Create a selection (can be saved, resolved, or both)
- `GET /api/selections/:id` - Get selection details
- `PUT /api/selections/:id` - Update selection (including saving or resolving)
- `DELETE /api/selections/:id` - Delete selection
- `GET /api/selections` - List selections with filters

### Query Operations

- `GET /api/documents/:id/selections` - Get all selections in a document
- `GET /api/documents/:id/highlights` - Get only saved selections (highlights)
- `GET /api/documents/:id/references` - Get only resolved selections (references)
- `GET /api/documents/:id/referenced-by` - Get incoming references to document

### Reference Operations

- `POST /api/selections/:id/create-document` - Wiki-style: Create new document from selection
- `POST /api/selections/:id/generate-document` - AI: Generate document content from selection context
- `GET /api/selections/:id/summary` - Get contextual summary for a selection

### Graph Operations

- `GET /api/graph/connections/:documentId` - Get all connected documents
- `GET /api/graph/path` - Find paths between documents
- `GET /api/graph/stats` - Analytics and statistics
- `GET /api/graph/entity-types` - Get entity type statistics

### Reference Tags

Common semantic relationship types that can be assigned to references:

- **Definitional**: `defines`, `defined-by`
- **Citation**: `cites`, `cited-by`
- **Support/Opposition**: `supports`, `refutes`, `contradicts`
- **Descriptive**: `mentions`, `describes`, `explains`, `summarizes`, `elaborates`
- **Structural**: `contains`, `part-of`, `follows`, `precedes`
- **Comparison**: `compares-to`, `contrasts-with`, `similar-to`
- **Dependency**: `depends-on`, `required-by`, `imports`, `exports`
- **Versioning**: `updates`, `replaces`, `deprecated-by`

## Selection Lifecycle

```text
1. Creation
   POST /api/selections
   {
     "documentId": "doc_123",
     "selectionType": { "type": "text_span", ... },
     "saved": false,  // Not a highlight (temporary selection)
     "resolvedDocumentId": null  // Not a reference yet
   }
   → Returns: { "id": "sel_456", ... }

2. Update to Highlight
   PUT /api/selections/sel_456
   {
     "saved": true  // Now it's a highlight
   }

3. Update to Reference
   PUT /api/selections/sel_456
   {
     "resolvedDocumentId": "doc_789",  // Now it's a reference
     "referenceTags": ["defines", "mentions"],  // Semantic relationship
     "entityTypes": ["Person"]  // And an entity reference
   }

4. Or create all at once
   POST /api/selections
   {
     "documentId": "doc_123",
     "selectionType": { "type": "text_span", ... },
     "saved": true,  // Highlight from the start
     "resolvedDocumentId": "doc_789",  // And reference
     "referenceTags": ["cites", "supports"],  // Semantic tags
     "entityTypes": ["Technology"]  // And entity reference
   }
```

## Example Workflows

### Text Document with Highlights and References

```json
POST /api/documents
{
  "name": "Quantum Computing Overview",
  "entityTypes": ["Topic", "Technology"],
  "content": "Quantum computing leverages quantum mechanics principles...",
  "contentType": "text/plain",
  "selections": [
    {
      "selectionType": {
        "type": "text_span",
        "offset": 0,
        "length": 17,
        "text": "Quantum computing"
      },
      "saved": true,  // This is a highlight
      "resolvedDocumentId": "doc_quantum_def",  // Also a reference
      "referenceTags": ["defines"],  // This selection defines the concept
      "entityTypes": ["Technology"]  // Entity reference
    }
  ]
}
```

### Auto-Detection and Resolution

```json
// 1. Detect selections (creates them with provisional flag)
POST /api/documents/:id/detect-selections
{
  "types": ["entities", "concepts"],
  "confidence": 0.8
}
→ Returns: { "selections": [{ "id": "sel_123", "provisional": true, ... }] }

// 2. Update to make permanent highlight
PUT /api/selections/sel_123
{
  "saved": true,
  "provisional": false
}

// 3. Update to resolve to document
PUT /api/selections/sel_123
{
  "resolvedDocumentId": "doc_xyz",
  "referenceTags": ["mentions", "describes"],
  "entityTypes": ["Person"]
}

// 4. Or create new document (wiki-style)
POST /api/selections/sel_123/create-document
{
  "name": "New Concept Definition",
  "entityTypes": ["Concept"]
}
```

## Database Schema

### Graph Database (JanusGraph/Neo4j/Neptune)

- **Documents**: Nodes with metadata
- **Selections**: Edges with properties:
  - `saved`: Boolean (highlight)
  - `resolvedDocumentId`: String (reference)
  - `referenceTags`: Array (semantic relationship types)
  - `entityTypes`: Array (entity reference)
  - Selection data (offset, length, etc.)

### Filesystem (EFS)

- Document content stored as files
- Path: `/documents/{shard}/{documentId}.dat`

## Design Rationale

### Why Selections are Always Persisted

1. **Consistency**: Every selection has an ID that can be referenced
2. **Provisional Workflow**: Auto-detected selections need IDs for user review
3. **Collaboration**: Other users can see and interact with selections
4. **History**: Track when selections were created, modified, resolved

### Ephemeral vs Saved

- **UI-only ephemeral**: User highlights text but doesn't interact - never hits API
- **Provisional (saved=false)**: Created by API (e.g., auto-detection) but not user-confirmed
- **Saved (saved=true)**: User explicitly wants to preserve this selection

## Future Enhancements

- [ ] Selection versioning/history
- [ ] Collaborative selections (multiple users)
- [ ] Selection annotations and comments
- [ ] Semantic relationship types for references
- [ ] Bulk selection operations
- [ ] Selection validation/constraints
- [ ] Graph schema management
- [ ] Auto-generate document summaries
- [ ] Selection search and filtering
- [ ] Selection analytics and insights