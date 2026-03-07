# Examples

Common use cases and patterns for `@semiont/make-meaning`.

## Context Assembly

### Getting Resource Metadata

```typescript
import { ResourceContext } from '@semiont/make-meaning';
import type { EnvironmentConfig } from '@semiont/core';

const config: EnvironmentConfig = {
  services: {
    backend: { publicURL: 'http://localhost:3000' },
  },
  storage: {
    base: './data',
  },
};

// Get single resource
const resource = await ResourceContext.getResourceMetadata(resourceId, config);
if (resource) {
  console.log(`Resource: ${resource.name}`);
  console.log(`Created: ${resource.created}`);
  console.log(`Format: ${resource.format}`);
}

// List all resources
const allResources = await ResourceContext.listResources(undefined, config);

// Filter by date and format
const recentDocs = await ResourceContext.listResources({
  createdAfter: '2024-01-01',
  mimeType: 'text/markdown',
  limit: 10
}, config);
```

### Loading Resource Content

```typescript
import { ResourceContext } from '@semiont/make-meaning';
import { FilesystemRepresentationStore } from '@semiont/content';
import { getPrimaryRepresentation, decodeRepresentation } from '@semiont/api-client';

// Get resource metadata
const resource = await ResourceContext.getResourceMetadata(resourceId, config);
if (!resource) throw new Error('Resource not found');

// Get primary representation (usually the original content)
const primaryRep = getPrimaryRepresentation(resource);
if (!primaryRep) throw new Error('No content available');

// Load from RepresentationStore
const repStore = new FilesystemRepresentationStore(
  { basePath: config.storage.base }
);
const buffer = await repStore.retrieve(
  primaryRep.checksum,
  primaryRep.mediaType
);

// Decode to string
const content = decodeRepresentation(buffer, primaryRep.mediaType);
console.log(`Loaded ${content.length} characters`);
```

### Adding Content Previews

```typescript
import { ResourceContext } from '@semiont/make-meaning';

// Get resources with content included
const resources = await ResourceContext.listResources({
  limit: 10
}, config);

const withPreviews = await ResourceContext.addContentPreviews(resources, config);

for (const resource of withPreviews) {
  console.log(`${resource.name}: ${resource.content.substring(0, 100)}...`);
}
```

## Working with Annotations

### Getting All Annotations

```typescript
import { AnnotationContext } from '@semiont/make-meaning';

// Get annotations organized by motivation
const annotationsByType = await AnnotationContext.getResourceAnnotations(
  resourceId,
  config
);

console.log(`Highlights: ${annotationsByType.highlighting?.length || 0}`);
console.log(`Comments: ${annotationsByType.commenting?.length || 0}`);
console.log(`Links: ${annotationsByType.linking?.length || 0}`);

// Get flat list of all annotations
const allAnnotations = await AnnotationContext.getAllAnnotations(
  resourceId,
  config
);
```

### Building LLM Context

```typescript
import { AnnotationContext } from '@semiont/make-meaning';

// Build rich context for AI processing
const context = await AnnotationContext.buildLLMContext(
  annotationUri,
  resourceId,
  config,
  {
    contextLines: 10,      // 10 lines before/after
    includeMetadata: true  // Include resource metadata
  }
);

// Context includes:
// - The annotation itself
// - Surrounding text (10 lines before/after)
// - Resource metadata (name, created date, format)
// - Related annotations in the vicinity

console.log(`Selected: "${context.selected}"`);
console.log(`Before: "${context.before}"`);
console.log(`After: "${context.after}"`);
```

### Generating Annotation Summaries

```typescript
import { AnnotationContext } from '@semiont/make-meaning';

// Generate AI summary with context
const summary = await AnnotationContext.generateAnnotationSummary(
  annotationId,
  resourceId,
  config
);

console.log(`Summary: ${summary.summary}`);
console.log(`Context: ${summary.context}`);
```

## Pattern Detection

### Detecting Highlights

```typescript
import { AnnotationDetection } from '@semiont/make-meaning';

// Basic highlight detection
const highlights = await AnnotationDetection.detectHighlights(
  resourceId,
  config,
  'Find key definitions and important concepts',
  0.5  // Medium density (~50% of passages)
);

console.log(`Found ${highlights.length} highlights`);
for (const highlight of highlights) {
  console.log(`- "${highlight.exact}" at ${highlight.start}-${highlight.end}`);
}
```

### Detecting Comments

```typescript
import { AnnotationDetection } from '@semiont/make-meaning';

// Detect passages that merit commentary
const comments = await AnnotationDetection.detectComments(
  resourceId,
  config,
  'Focus on technical explanations that need clarification',
  'educational',  // Tone: educational, analytical, constructive
  0.3  // Lower density (~30% of passages)
);

for (const comment of comments) {
  console.log(`Passage: "${comment.exact}"`);
  console.log(`Comment: ${comment.comment}`);
  console.log();
}
```

### Detecting Assessments

```typescript
import { AnnotationDetection } from '@semiont/make-meaning';

// Detect passages that merit evaluation
const assessments = await AnnotationDetection.detectAssessments(
  resourceId,
  config,
  'Evaluate clarity, accuracy, and completeness',
  'constructive',
  0.4
);

for (const assessment of assessments) {
  console.log(`Passage: "${assessment.exact}"`);
  console.log(`Assessment: ${assessment.assessment}`);
  console.log();
}
```

## Structured Tagging

### Tagging Legal Documents (IRAC)

```typescript
import { AnnotationDetection } from '@semiont/make-meaning';
import { getTagSchema } from '@semiont/ontology';

// Get IRAC schema (Issue, Rule, Application, Conclusion)
const schema = getTagSchema('irac');
console.log(`Schema: ${schema.name}`);
console.log(`Description: ${schema.description}`);

// Detect each category
const categories = ['issue', 'rule', 'application', 'conclusion'];
const results: Record<string, number> = {};

for (const category of categories) {
  const tags = await AnnotationDetection.detectTags(
    resourceId,
    config,
    'irac',
    category
  );

  results[category] = tags.length;
  console.log(`\n${category.toUpperCase()}:`);
  for (const tag of tags) {
    console.log(`- "${tag.exact.substring(0, 100)}..."`);
  }
}

console.log(`\nSummary: ${JSON.stringify(results)}`);
// Example: { issue: 3, rule: 8, application: 12, conclusion: 2 }
```

### Tagging Scientific Papers (IMRAD)

```typescript
import { AnnotationDetection } from '@semiont/make-meaning';

// IMRAD: Introduction, Methods, Results, Discussion
const categories = ['introduction', 'methods', 'results', 'discussion'];

for (const category of categories) {
  const tags = await AnnotationDetection.detectTags(
    resourceId,
    config,
    'imrad',
    category
  );

  console.log(`\n${category}: ${tags.length} sections`);
}
```

### Custom Domain Analysis

```typescript
import { AnnotationDetection } from '@semiont/make-meaning';

// Analyze philosophical arguments using Toulmin model
const toulminCategories = [
  'claim',
  'grounds',
  'warrant',
  'backing',
  'qualifier',
  'rebuttal'
];

const toulminStructure: Record<string, any[]> = {};

for (const category of toulminCategories) {
  const tags = await AnnotationDetection.detectTags(
    resourceId,
    config,
    'toulmin',
    category
  );

  toulminStructure[category] = tags;
}

// Now you can traverse the argument structure
console.log('Argument Structure:');
console.log(`Claims: ${toulminStructure.claim.length}`);
console.log(`Evidence: ${toulminStructure.grounds.length}`);
console.log(`Warrants: ${toulminStructure.warrant.length}`);
```

## Creating Annotations from Detections

### Creating Highlight Annotations

```typescript
import { AnnotationDetection } from '@semiont/make-meaning';
import { createEventStore, generateAnnotationId } from '@semiont/event-sourcing';
import { resourceIdToURI } from '@semiont/core';

// Detect highlights
const highlights = await AnnotationDetection.detectHighlights(
  resourceId,
  config,
  'Find key concepts',
  0.6
);

// Create Event Store
const eventStore = await createEventStore(config);

// Create annotation for each highlight
for (const highlight of highlights) {
  const annotationId = generateAnnotationId(config.services.backend.publicURL);
  const resourceUri = resourceIdToURI(resourceId, config.services.backend.publicURL);

  const annotation = {
    '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
    type: 'Annotation' as const,
    id: annotationId,
    motivation: 'highlighting' as const,
    target: {
      type: 'SpecificResource' as const,
      source: resourceUri,
      selector: [
        {
          type: 'TextPositionSelector' as const,
          start: highlight.start,
          end: highlight.end,
        },
        {
          type: 'TextQuoteSelector' as const,
          exact: highlight.exact,
          prefix: highlight.prefix || '',
          suffix: highlight.suffix || '',
        },
      ],
    },
    body: [],
  };

  await eventStore.appendEvent({
    type: 'annotation.added',
    resourceId,
    userId,
    version: 1,
    payload: { annotation },
  });

  console.log(`Created highlight: ${annotationId}`);
}
```

### Creating Comment Annotations

```typescript
import { AnnotationDetection } from '@semiont/make-meaning';
import { createEventStore, generateAnnotationId } from '@semiont/event-sourcing';

const comments = await AnnotationDetection.detectComments(
  resourceId,
  config,
  'Add helpful explanations',
  'educational',
  0.3
);

const eventStore = await createEventStore(config);

for (const comment of comments) {
  const annotationId = generateAnnotationId(config.services.backend.publicURL);
  const resourceUri = resourceIdToURI(resourceId, config.services.backend.publicURL);

  const annotation = {
    '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
    type: 'Annotation' as const,
    id: annotationId,
    motivation: 'commenting' as const,
    target: {
      type: 'SpecificResource' as const,
      source: resourceUri,
      selector: [
        {
          type: 'TextPositionSelector' as const,
          start: comment.start,
          end: comment.end,
        },
        {
          type: 'TextQuoteSelector' as const,
          exact: comment.exact,
          prefix: comment.prefix || '',
          suffix: comment.suffix || '',
        },
      ],
    },
    body: [
      {
        type: 'TextualBody' as const,
        value: comment.comment,
        purpose: 'commenting' as const,
        format: 'text/plain',
        language: 'en',
      },
    ],
  };

  await eventStore.appendEvent({
    type: 'annotation.added',
    resourceId,
    userId,
    version: 1,
    payload: { annotation },
  });
}
```

## Graph Traversal

### Finding Backlinks

```typescript
import { GraphContext } from '@semiont/make-meaning';

// Find all resources that reference this one
const backlinks = await GraphContext.getBacklinks(resourceId, config);

console.log(`Found ${backlinks.length} backlinks:`);
for (const annotation of backlinks) {
  console.log(`- From: ${annotation.target.source}`);
}
```

### Finding Connection Paths

```typescript
import { GraphContext } from '@semiont/make-meaning';

// Find shortest path between two resources
const paths = await GraphContext.findPath(
  sourceResourceId,
  targetResourceId,
  config,
  3  // Max depth: 3 hops
);

if (paths.length === 0) {
  console.log('No connection found within 3 hops');
} else {
  const shortest = paths[0];
  console.log(`Path length: ${shortest.nodes.length} nodes`);
  console.log(`Path: ${shortest.nodes.map(n => n.id).join(' → ')}`);
}
```

### Getting All Connections

```typescript
import { GraphContext } from '@semiont/make-meaning';

// Get all graph connections for a resource
const connections = await GraphContext.getResourceConnections(resourceId, config);

console.log(`Resource has ${connections.length} connections:`);
for (const conn of connections) {
  console.log(`${conn.from} → ${conn.to} (via ${conn.via})`);
}
```

### Full-Text Search

```typescript
import { GraphContext } from '@semiont/make-meaning';

// Search across all resources
const results = await GraphContext.searchResources(
  'neural networks',
  config,
  10  // Limit: 10 results
);

console.log(`Found ${results.length} matching resources:`);
for (const resource of results) {
  console.log(`- ${resource.name}`);
}
```

## Advanced Patterns

### Cross-Document Tag Analysis

```typescript
import { AnnotationContext, GraphContext } from '@semiont/make-meaning';

// Find all "issue" tags across multiple legal briefs
async function findAllIssues(resourceIds: ResourceId[]) {
  const allIssues: Array<{ resource: string; issues: any[] }> = [];

  for (const resourceId of resourceIds) {
    const annotations = await AnnotationContext.getResourceAnnotations(
      resourceId,
      config
    );

    // Filter for IRAC "issue" tags
    const issueTags = (annotations.tagging || []).filter(anno => {
      const bodies = Array.isArray(anno.body) ? anno.body : [anno.body];
      return bodies.some(b =>
        b.purpose === 'tagging' &&
        b.value === 'issue'
      );
    });

    allIssues.push({
      resource: resourceId,
      issues: issueTags
    });
  }

  return allIssues;
}

// Usage
const briefs = await GraphContext.searchResources('legal brief', config);
const issues = await findAllIssues(briefs.map(b => b.id));
console.log(`Found ${issues.flatMap(i => i.issues).length} issue statements across ${briefs.length} briefs`);
```

### Building Context for Related Resources

```typescript
import { GraphContext, AnnotationContext } from '@semiont/make-meaning';

// Get context including related resources
async function getEnhancedContext(resourceId: ResourceId, annotationUri: AnnotationUri) {
  // Get annotation context
  const context = await AnnotationContext.buildLLMContext(
    annotationUri,
    resourceId,
    config,
    { contextLines: 5 }
  );

  // Get backlinks to find related discussions
  const backlinks = await GraphContext.getBacklinks(resourceId, config);

  // Get connections to find related resources
  const connections = await GraphContext.getResourceConnections(resourceId, config);

  return {
    ...context,
    backlinks: backlinks.length,
    relatedResources: connections.length
  };
}
```

### Batch Processing Multiple Resources

```typescript
import { ResourceContext, AnnotationDetection } from '@semiont/make-meaning';

// Process all recent documents
async function processRecentDocuments() {
  const resources = await ResourceContext.listResources({
    createdAfter: '2024-01-01',
    mimeType: 'text/markdown'
  }, config);

  console.log(`Processing ${resources.length} documents...`);

  for (const resource of resources) {
    console.log(`\nProcessing: ${resource.name}`);

    // Detect highlights
    const highlights = await AnnotationDetection.detectHighlights(
      resource.id,
      config,
      'Find key concepts',
      0.5
    );
    console.log(`- Found ${highlights.length} highlights`);

    // Detect comments
    const comments = await AnnotationDetection.detectComments(
      resource.id,
      config,
      'Add helpful explanations',
      'educational',
      0.3
    );
    console.log(`- Found ${comments.length} comments`);

    // Create annotations (not shown)
  }
}
```

## See Also

- [API Reference](./api-reference.md) - Complete API documentation
- [Job Workers](./job-workers.md) - Asynchronous processing
- [Architecture](./architecture.md) - System design
- [@semiont/ontology](../../ontology/README.md) - Tag schemas
