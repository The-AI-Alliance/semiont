# References in Semiont

## Overview

Semiont supports two distinct types of references that can be applied to selected text within documents: **Document References** and **Entity References**. Both serve different purposes in organizing and connecting knowledge.

## Document References

Document references create explicit links between documents in the system.

### Characteristics
- **Purpose**: Link selected text to another document in the system
- **Target**: Has a `referencedDocumentId` that points to a specific document
- **Navigation**: When clicked, navigates directly to the referenced document
- **Reference Types**: Can be categorized as:
  - `citation` - References to source material
  - `definition` - Links to defining documents
  - `elaboration` - Points to more detailed explanations
  - `example` - Links to example documents
  - `related` - General related content

### Use Cases
- Creating a knowledge graph between documents
- Building hierarchical documentation structures
- Citing sources and references
- Connecting related concepts across documents

### Technical Implementation
```typescript
// Document reference structure
{
  type: 'reference',
  referencedDocumentId: 'doc-uuid-123',
  referenceType: 'citation' | 'definition' | 'elaboration' | 'example' | 'related',
  text: 'selected text',
  position: { start: 100, end: 150 }
}
```

### Document Provenance
When documents are created from references, provenance information is tracked:
```typescript
{
  creationMethod: 'reference',  // How the document was created
  sourceDocumentId: 'doc-uuid-456',  // Original document containing the reference
  sourceSelectionId: 'sel-uuid-789',  // The selection that triggered creation
  contentChecksum: 'sha256-hash',  // Content integrity hash (backend-calculated)
  createdAt: '2024-01-15T10:30:00Z',  // Timestamp (backend-set)
  createdBy: 'user-uuid'  // User ID (backend-derived from auth)
}
```

## Entity References

Entity references mark text as representing a specific type of entity for semantic annotation.

### Characteristics
- **Purpose**: Semantically mark text as representing an entity
- **Target**: Does not link to another document
- **Entity Types**: Common types include:
  - `Person` - Names of people
  - `Organization` - Company or organization names
  - `Location` - Places, addresses, geographic locations
  - `Event` - Named events
  - `Concept` - Abstract concepts or ideas
  - `Product` - Product names
  - `Technology` - Technologies, frameworks, tools
  - `Date` - Temporal references
  - `Other` - Custom entity types

### Use Cases
- Semantic markup for improved search and filtering
- Building entity indexes across documents
- Knowledge extraction and organization
- Future AI/ML processing of document content
- Creating entity-based navigation and discovery

### Technical Implementation
```typescript
// Entity reference structure
{
  type: 'reference',
  entityType: 'Person' | 'Organization' | 'Location' | etc.,
  referenceType: 'entity',  // Distinguishes from document references
  text: 'John Smith',
  position: { start: 200, end: 210 }
}
```

## Document-Level Entity Types

In addition to inline entity references, documents can have document-level entity type tags.

### Purpose
- Indicate what types of entities the document contains overall
- Enable filtering and categorization at the document level
- Provide quick overview of document content types
- Support faceted search and navigation

### Location
- Displayed in the right sidebar on document pages
- Editable through the UI with add/remove capabilities
- Persisted with the document metadata

### Difference from Entity References
- **Scope**: Document-level vs. specific text selection
- **Purpose**: Categorization vs. semantic markup
- **Usage**: Filtering/search vs. knowledge extraction

## Visual Distinctions

The UI provides clear visual differences between reference types:

### Document References
- Displayed with gradient background (cyan to blue)
- Show link icon or reference type indicator
- Clickable for navigation
- Right-click menu offers conversion options

### Entity References  
- Displayed with purple/violet styling
- Show entity type as label
- Non-navigable (no click action)
- Right-click menu for management options

### Highlights
- Simple yellow background
- No additional metadata
- Can be converted to references
- Basic annotation for important text

## Creating References

### Text Selection Workflow
Semiont preserves the standard browser text selection behavior, allowing normal copy/paste operations while providing easy access to annotation features:

1. **Select text normally** - Click and drag to select text as you would in any application
2. **Copy/paste preserved** - Use `Ctrl+C`/`Cmd+C` to copy selected text without interference
3. **Access "Create Selection" popup**:
   - **Right-click** on selected text for immediate access
   - **Hover for 2 seconds** over selected text to auto-show the popup
   - Visual feedback: cursor changes to help icon and tooltip appears when hovering

### Via Selection Popup
Once the "Create Selection" popup appears:

1. **Choose annotation type** from three tabs:
   - **Highlight**: Simple yellow highlighting for important text
   - **Reference Document**: Link to another document
   - **Entity Reference**: Mark as semantic entity

2. **For Document References**:
   - Select reference type (citation, definition, elaboration, example, related)
   - Search for existing documents by name
   - Select from search results, or
   - Create a new document with the selected text as context

3. **For Entity References**:
   - Choose from predefined entity types (Person, Organization, Location, etc.)
   - Or select "Other" to enter a custom entity type
   - Click "Create Entity Reference" to apply

### Via Keyboard Shortcuts
- `Ctrl+H` / `Cmd+H`: Create highlight quickly without popup
- `Esc`: Cancel text selection and close any open popups

### Via Context Menu
For existing annotations (highlights, references):
- Right-click on the annotation to open context menu
- Available actions:
  - **Navigate** to referenced document (for document references)
  - **Convert** highlight to reference
  - **Delete** the annotation
  - **Copy** referenced text

## API Endpoints

### Reference Management
- `POST /api/selections` - Create new reference
- `GET /api/selections` - List references
- `DELETE /api/selections/:id` - Remove reference
- `PUT /api/selections/:id/resolve` - Resolve reference to document

### Entity Types
- `GET /api/entity-types` - List available entity types
- `GET /api/reference-types` - List available reference types

### Document Entity Types
- `PUT /api/documents/:id` - Update document with entity types
- `GET /api/documents/:id` - Retrieve document with entity types

## Best Practices

1. **Use Document References when**:
   - You need navigable links between documents
   - Building documentation hierarchies
   - Creating citation networks

2. **Use Entity References when**:
   - Marking up semantic information
   - Building entity indices
   - Preparing for search/filter operations

3. **Use Document-Level Entity Types when**:
   - Categorizing entire documents
   - Enabling document filtering
   - Providing document overviews

## Recent Improvements

### Selection Workflow (Latest)
- Non-intrusive text selection that preserves copy/paste functionality
- Right-click and long-hover triggers for selection popup
- Visual feedback with cursor changes and tooltips
- Improved user experience for creating annotations

### Document Provenance Tracking
- Automatic tracking of document creation source and method
- Content integrity verification with SHA-256 checksums
- Backend-controlled security fields (timestamps, user ID, checksums)
- Full audit trail for document lineage

## Future Enhancements

### Entity Management
- Entity reference resolution to entity database
- Automatic entity recognition using NLP
- Entity relationship mapping and visualization
- Cross-document entity analytics
- Entity-based search and discovery

### Reference Features
- Bidirectional reference tracking
- Reference strength/confidence scoring
- Bulk reference management tools
- Reference validation and broken link detection
- Reference usage analytics

### User Experience
- Keyboard navigation between references
- Reference preview on hover
- Batch operations for multiple selections
- Customizable reference colors and styles
- Reference templates for common patterns