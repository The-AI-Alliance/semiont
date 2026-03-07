# Frontend Features

**Last Updated**: 2025-10-25

User-facing features of the Semiont frontend, including document management, annotations, and knowledge graph building.

## Table of Contents

- [Overview](#overview)
- [Supported Formats](#supported-formats)
- [Document Operations](#document-operations)
- [Selection System](#selection-system)
- [Format-Specific Features](#format-specific-features)
- [User Interface Components](#user-interface-components)
- [Asynchronous AI Features](#asynchronous-ai-features)
- [Related Documentation](#related-documentation)

## Overview

The Semiont frontend provides a rich document management and annotation experience built on W3C Web Annotation standards. Users can:

- Create and manage documents in multiple formats (text, markdown, images, PDFs)
- Annotate content with highlights, references, and entity tags
- Build a semantic knowledge graph through annotations
- Search and discover related documents
- Export annotations as JSON-LD

## Supported Formats

Semiont supports multiple document formats, each with format-appropriate annotation capabilities:

### Text Formats
- **Plain Text** (`text/plain`) - Raw text documents with text-based annotations
- **Markdown** (`text/markdown`) - Formatted documents with GitHub Flavored Markdown support

### Image Formats
- **PNG** (`image/png`) - Raster images with spatial coordinate annotations
- **JPEG** (`image/jpeg`) - Compressed images with spatial coordinate annotations

### Document Formats
- **PDF** (`application/pdf`) - Portable documents with spatial coordinate annotations

### Annotation Support by Format

| Format            | View | Annotate | Annotation Detection |
|-------------------|------|----------|----------------------|
| Text/Markdown     | ✅   | ✅       | ✅                   |
| Images (PNG/JPEG) | ✅   | ✅       | ⚠️ Future            |
| PDF               | ✅   | ✅       | ⚠️ Future            |

**Note**: Text-based formats use `TextPositionSelector` and `TextQuoteSelector` for precise character-based annotations. Image and PDF formats use `FragmentSelector` (RFC 3778) for spatial coordinate-based annotations.

## Document Operations

### Search
- Full-text search for documents by name
- Real-time results as you type
- Content preview in search results
- Filter by document type or metadata

### Create
- Create new markdown documents with initial content
- Auto-save drafts
- Template support for common document types
- Wiki-style linking during creation

### View
- Render markdown with syntax highlighting
- Wiki-style links (`[[page name]]`) navigate internally
- Split-view layout (content + sidebar)
- Real-time display of annotations

### Navigate
- Click wiki links to navigate between documents
- Breadcrumb navigation
- Document backlinks (documents that reference this one)
- Related documents suggestions

### Edit
- Markdown editor with live preview
- Syntax highlighting for code blocks
- Auto-complete for wiki links
- Keyboard shortcuts for common formatting

### Archive & Clone
- Archive documents without deletion
- Clone documents with or without annotations
- Restore archived documents
- Version history (future)

See [ARCHIVE-CLONE.md](./ARCHIVE-CLONE.md) for complete archiving and cloning documentation.

## Selection System

Users can select any text within a document to create three types of annotations:

### 1. Highlights

Mark important text passages for later reference.

**Features**:
- Visual indication with yellow background
- Saved highlights appear in document sidebar
- Persistent across sessions
- Quick create from text selection
- Delete highlights individually

**Use Cases**:
- Mark key points while reading
- Highlight quotes for later reference
- Note interesting passages

**W3C Compliance**: Highlights are W3C Web Annotations with `purpose: "highlighting"`.

### 2. Document References

Link selected text to other documents in the system.

**Reference Types**:
- **Citation**: Reference to source material
- **Definition**: Link to defining document
- **Elaboration**: Extended explanation or expansion
- **Example**: Illustrative example of a concept
- **Related**: Related concept or topic

**Features**:
- Search for existing documents to link
- Create new documents on the fly
- Referenced documents accessible via sidebar
- Backlinks show incoming references
- Resolve stub references (future)

**Use Cases**:
- Build knowledge graph through document linking
- Create citation networks
- Link definitions to usage examples
- Connect related concepts

**W3C Compliance**: References are W3C Web Annotations with `SpecificResource` body and `purpose: "linking"`.

### 3. Entity References

Mark text as referring to specific entities in your knowledge graph.

**Pre-defined Entity Types**:
- **Person**: Individuals and characters
- **Organization**: Companies, institutions, groups
- **Location**: Places, regions, addresses
- **Event**: Historical events, meetings, conferences
- **Concept**: Abstract ideas, theories, principles
- **Product**: Products, tools, software
- **Technology**: Technologies, frameworks, protocols
- **Date**: Specific dates and time periods
- **Custom**: User-defined entity types via "Other" option

**Features**:
- Entity type selection grid
- Auto-detection via AI (see [Asynchronous AI Features](#asynchronous-ai-features))
- Entity co-occurrence discovery
- Entity-document relationships
- Export as semantic triples

**Use Cases**:
- Build entity-centric knowledge graphs
- Track people, organizations, and concepts
- Create semantic search indexes
- Generate entity relationship diagrams

**W3C Compliance**: Entity tags are W3C Web Annotations with `TextualBody` body and `purpose: "tagging"`.

### Multi-Body Annotations

Semiont supports **multi-body annotations** combining entity tags and document links:

**Example**:
Select "Albert Einstein" and create:
- Entity tag: Person
- Document reference: Link to Einstein biography
- Result: One annotation with two bodies (one `TextualBody`, one `SpecificResource`)

See [API Integration Guide](./API-INTEGRATION.md#w3c-web-annotation-model) for technical details.

## Format-Specific Features

### Text and Markdown

Full markdown rendering with extended features:

#### GitHub Flavored Markdown
- **Tables**: Pipe-delimited tables with alignment
- **Task Lists**: `- [ ]` checkbox lists
- **Strikethrough**: `~~deleted text~~`
- **Autolinks**: Automatic URL linking

#### Wiki-Style Links
- **Syntax**: `[[page name]]`
- **Navigation**: Click to navigate internally
- **Auto-complete**: Suggestions while typing
- **Stub Detection**: Highlight broken links

#### Syntax Highlighting
- Code blocks with language-specific highlighting
- Inline code formatting
- Line numbers (optional)
- Copy-to-clipboard buttons

#### Interactive Elements
- External links open in new tabs
- Wiki links navigate internally
- Table of contents auto-generation (future)
- Collapsible sections (future)

See [ANNOTATION-OVERLAY.md](../../../ANNOTATION-OVERLAY.md) for markdown rendering details.

### Images (PNG/JPEG)

Image viewing with spatial annotation support:

#### Viewing Features
- Native image rendering with zoom controls
- Responsive scaling to fit viewport
- Pan and zoom for detailed inspection
- High-resolution image support

#### Annotation Features
- **Rectangular regions**: Draw boxes on images to annotate specific areas
- **Spatial coordinates**: Annotations use SVG coordinate system
- **Visual indicators**: Highlighted regions with hover states
- **Multiple annotations**: Support for overlapping regions

**Future Work**: AI-powered annotation detection for images (object recognition, OCR for text in images)

### PDF Documents

PDF viewing and annotation with page-by-page navigation:

#### Viewing Features
- Multi-page PDF rendering
- Page navigation (next/previous controls)
- Zoom and scale controls
- Text layer rendering for searchability

#### Annotation Features
- **Rectangular regions**: Draw boxes on PDF pages to annotate specific areas
- **RFC 3778 compliance**: FragmentSelector with `page=N&viewrect=left,top,width,height`
- **Page-specific annotations**: Annotations tied to specific PDF pages
- **Visual indicators**: Highlighted regions with hover states
- **Coordinate transformation**: Automatic conversion between PDF and canvas coordinates

**Future Work**: AI-powered annotation detection for PDFs (text extraction, entity recognition, layout analysis)

## User Interface Components

### AuthenticatedHome

Landing page for authenticated users.

**Components**:
- Document search bar with live results
- Create new document button with modal
- Recent documents list
- Personalized welcome message
- Quick stats (document count, annotation count)

**User Flow**:
1. User logs in
2. Sees welcome message and quick stats
3. Searches for document or creates new one
4. Navigates to document viewer

### Document Viewer

Split-view layout for reading and annotating documents.

**Layout**:
- **Content Area**: Rendered markdown with annotations highlighted
- **Sidebar**: Highlights, references, entity tags, backlinks
- **Header**: Document title, metadata, edit button
- **Footer**: Keyboard shortcuts, help

**Interactions**:
- Text selection triggers annotation popup
- Click annotation to view details
- Hover over annotation for preview
- Keyboard navigation (see [KEYBOARD-NAV.md](./KEYBOARD-NAV.md))

**Features**:
- Real-time annotation updates
- Undo/redo for annotations (future)
- Collaborative editing (future)
- Version history (future)

### Selection Popup

Multi-tab interface for creating annotations from selected text.

**Tabs**:
1. **Highlight**: Save selection as highlight
2. **Reference**: Link to existing or new document
3. **Entity**: Tag with entity type

**Components**:
- Inline document search with live results
- Entity type selection grid with icons
- Reference type dropdown
- "Create new document" quick action
- Preview pane showing selected text

**User Flow**:
1. User selects text
2. Popup appears with tabs
3. User chooses annotation type
4. Fills in details (entity type, reference document, etc.)
5. Clicks save
6. Annotation appears in sidebar

### Search Interface

Global search for documents.

**Features**:
- Full-text search across all documents
- Filter by entity type, author, date
- Sort by relevance, date, title
- Pagination for large result sets
- Export search results (future)

### Entity Browser (Future)

Browse and explore entities across all documents.

**Planned Features**:
- Entity list with counts
- Entity detail pages
- Entity relationship graph visualization
- Entity co-occurrence matrix
- Entity timeline

## Asynchronous AI Features

Some features use background AI processing with real-time progress tracking.

### Annotation Detection

Automatically detect annotations in documents using AI (highlights, assessments, comments, tags, entity references).

**How It Works**:
1. User clicks "Detect Entities" button
2. Selects entity types to detect (Person, Organization, etc.)
3. Job starts, UI shows progress bar
4. Entities detected and added as annotations
5. User reviews and edits detected entities

**Progress Tracking**:
- Real-time progress via Server-Sent Events (SSE)
- Shows current entity type being processed
- Displays entities found count
- Cancellable during processing

**See**: [API Integration Guide](./API-INTEGRATION.md#entity-detection-with-sse) for implementation details.

### Document Generation

Generate new documents from annotations using AI.

**How It Works**:
1. User selects annotation
2. Clicks "Generate Document" action
3. AI generates document based on annotation context
4. New document created and linked
5. User can edit generated content

**Progress Tracking**:
- Real-time progress via SSE
- Shows generation stages (fetching, generating, creating, linking)
- Percentage complete
- Preview of generated content (future)

**See**: [API Integration Guide](./API-INTEGRATION.md#document-generation-with-sse) for implementation details.

## Related Documentation

### User Guides
- [Annotations](./ANNOTATIONS.md) - Complete annotation system documentation
- [Keyboard Navigation](./KEYBOARD-NAV.md) - WCAG-compliant keyboard shortcuts
- [Archive & Clone](./ARCHIVE-CLONE.md) - Document archiving and cloning

### Technical Documentation
- [API Integration](./API-INTEGRATION.md) - API usage, async operations, W3C annotations
- [Frontend Architecture](./ARCHITECTURE.md) - High-level system design
- [Rendering Architecture](../../../packages/react-ui/docs/RENDERING-ARCHITECTURE.md) - Document rendering pipeline

### Development Guides
- [Development Guide](./DEVELOPMENT.md) - Local development workflows
- [Style Guide](./style-guide.md) - UI/UX patterns and component guidelines
- [CodeMirror Integration](../../../packages/react-ui/docs/CODEMIRROR-INTEGRATION.md) - Editor implementation

### External Resources
- [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/) - Official specification
- [GitHub Flavored Markdown](https://github.github.com/gfm/) - Markdown specification
- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/) - Accessibility guidelines

---

**Last Updated**: 2025-10-25
**For Feature Requests**: File an issue or see [Contributing Guide](../../../docs/CONTRIBUTING.md)
