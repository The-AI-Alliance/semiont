# W3C Web Annotation Data Model

Semiont implements the [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/), a standard specification for creating, sharing, and managing annotations across the web.

**Related Documentation:**
- [W3C Selectors](./W3C-SELECTORS.md) - Text and image selector implementation
- [Knowledge System](../system/KNOWLEDGE-SYSTEM.md) - How annotations flow through the event store, materialized views, and graph
- [Semiont Protocol](./README.md) - The eight verbs and the bus these annotations travel on
- [OpenAPI Specification](../../specs/openapi.json) - Machine-readable API contract

## Table of Contents

1. [W3C Annotation Structure](#w3c-annotation-structure)
2. [Annotation Types](#annotation-types)
3. [Multiple Bodies Pattern](#multiple-bodies-pattern)
4. [Target Structures](#target-structures)
5. [Selectors](#selectors)
6. [JSON-LD Export](#json-ld-export)

---

## W3C Annotation Structure

Every W3C annotation has these required fields:

```json
{
  "@context": "http://www.w3.org/ns/anno.jsonld",
  "type": "Annotation",
  "id": "https://example.org/annotations/anno-123",
  "creator": {
    "@type": "Person",
    "@id": "did:web:example.org:users:alice",
    "name": "Alice"
  },
  "created": "2025-10-24T10:30:00Z",
  "motivation": "linking",
  "target": {
    "source": "https://example.org/documents/doc-123",
    "selector": [...]
  },
  "body": [...]
}
```

### Core Fields

- **`@context`**: JSON-LD context (always `"http://www.w3.org/ns/anno.jsonld"`)
- **`type`**: Always `"Annotation"`
- **`id`**: Unique identifier (IRI)
- **`creator`**: W3C Agent naming who *requested* the annotation — derived by the knowledge base from the verified emitter of the write, or of the job the write cites; never set by the emitter
- **`created`**: ISO 8601 timestamp
- **`motivation`**: Why the annotation was created
- **`target`**: What is being annotated
- **`body`**: The annotation content (can be array or single object)

### Optional Fields

- **`modified`**: ISO 8601 timestamp of last modification
- **`wasAttributedTo`**: PROV-O — every party responsible: `[creator, generator]`, collapsed to the one agent when requester and producer are the same. Derived, like `creator`.
- **`generator`**: Software that produced the annotation (W3C §3.2.1). Present on every annotation a software agent wrote. The writer may supply it to carry the model's parameters, but its identity must be the writer's own — the knowledge base refuses a `generator` naming anyone else, and supplies it from the verified emitter when omitted:

```json
{
  "generator": {
    "@type": "Software",
    "@id": "did:web:example.org:agents:anthropic:claude-sonnet-4-6",
    "name": "anthropic claude-sonnet-4-6",
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "parameters": { "temperature": 0.2 }
  }
}
```

`creator` is who requested the annotation; `generator` is the software that produced it; `wasAttributedTo` is every party responsible. All three are **derived by the knowledge base** at write time from identities the gateway verified: the write's emitter (`_userId`), and — when the write cites a job (`jobId`) — the emitter of the `job:create` that produced it, joined through the dispatcher's own `job:assigned` record. Nothing an emitter says about identity in a payload is honoured: a payload carrying `creator` is refused, as is a `generator` whose identity is not the emitter's. A person's own annotation carries no `generator`; a person's act and a software agent's act are described the same way.

**A Person's `name` is not stored on the annotation — it is resolved when the annotation is read.** What is written is the `@id`: provenance joins on the DID and only the DID. What a person is called is a separate fact about that identity, taken from the issuer's verified `name` claim, recorded on the knowledge base's own log once per *change* rather than once per act, and filled in by the Archivist on the way out. Two consequences worth knowing: a correction or a change of name reaches **every** annotation its subject ever wrote, because none of them froze a copy; and a DID the knowledge base has no name for comes back with no `name` at all, which is the honest shape — never a placeholder, and never the DID's own subject, which is an opaque identifier and not a name. A Software agent is different: its name derives from its provider and model, which its DID carries, so it is named where it is built.

## Annotation Types

Semiont uses three W3C motivations:

### 1. Highlighting (`motivation: "highlighting"`)

Mark important text with a comment:

```json
{
  "@context": "http://www.w3.org/ns/anno.jsonld",
  "type": "Annotation",
  "id": "anno-highlight-456",
  "motivation": "highlighting",
  "target": {
    "source": "doc-123",
    "selector": [
      {
        "type": "TextPositionSelector",
        "start": 500,
        "end": 505
      },
      {
        "type": "TextQuoteSelector",
        "exact": "E=mc²"
      }
    ]
  },
  "body": {
    "type": "TextualBody",
    "value": "Famous equation from special relativity",
    "purpose": "commenting",
    "format": "text/plain"
  },
  "creator": {
    "@type": "Person",
    "@id": "did:web:example.org:users:alice",
    "name": "Alice"
  },
  "created": "2025-10-24T14:30:00Z"
}
```

### 2. Linking (`motivation: "linking"`)

Link text to another document with entity type tags:

```json
{
  "@context": "http://www.w3.org/ns/anno.jsonld",
  "type": "Annotation",
  "id": "anno-link-123",
  "motivation": "linking",
  "target": {
    "source": "doc-123",
    "selector": [
      {
        "type": "TextPositionSelector",
        "start": 100,
        "end": 115
      },
      {
        "type": "TextQuoteSelector",
        "exact": "Albert Einstein"
      }
    ]
  },
  "body": [
    {
      "type": "TextualBody",
      "value": "Person",
      "purpose": "tagging"
    },
    {
      "type": "TextualBody",
      "value": "Scientist",
      "purpose": "tagging"
    },
    {
      "type": "SpecificResource",
      "source": "doc-einstein-bio",
      "purpose": "linking"
    }
  ],
  "creator": {
    "@type": "Person",
    "@id": "did:web:example.org:users:alice",
    "name": "Alice"
  },
  "created": "2025-10-24T10:30:00Z"
}
```

### 3. Stub References (Unresolved Links)

A `linking` annotation with empty body array indicates a planned link not yet resolved:

```json
{
  "@context": "http://www.w3.org/ns/anno.jsonld",
  "type": "Annotation",
  "id": "anno-stub-789",
  "motivation": "linking",
  "target": {
    "source": "doc-123",
    "selector": [
      {
        "type": "TextPositionSelector",
        "start": 200,
        "end": 220
      },
      {
        "type": "TextQuoteSelector",
        "exact": "quantum entanglement"
      }
    ]
  },
  "body": [],
  "creator": {
    "@type": "Person",
    "@id": "did:web:example.org:users:alice",
    "name": "Alice"
  },
  "created": "2025-10-24T11:00:00Z"
}
```

**Stub references** enable progressive knowledge graph building - users mark locations for linking before determining the target document.

## Multiple Bodies Pattern

W3C allows annotations to have **multiple bodies**, each serving a different purpose.

### Example: Entity Type Tags + Document Link

```json
{
  "@context": "http://www.w3.org/ns/anno.jsonld",
  "type": "Annotation",
  "id": "anno-multi-body",
  "motivation": "linking",
  "target": {
    "source": "doc-source",
    "selector": [...]
  },
  "body": [
    {
      "type": "TextualBody",
      "value": "Person",
      "purpose": "tagging"
    },
    {
      "type": "TextualBody",
      "value": "Physicist",
      "purpose": "tagging"
    },
    {
      "type": "SpecificResource",
      "source": "doc-einstein-bio",
      "purpose": "linking"
    }
  ],
  "creator": {...},
  "created": "2025-10-24T10:30:00Z"
}
```

### Body Item Types

**TextualBody** - Text content with purpose:

```json
{
  "type": "TextualBody",
  "value": "Person",
  "purpose": "tagging",
  "format": "text/plain",
  "language": "en"
}
```

**SpecificResource** - Link to another resource:

```json
{
  "type": "SpecificResource",
  "source": "doc-target-id",
  "purpose": "linking"
}
```

### Body Purposes

- **`tagging`**: Classification/entity type tags
- **`commenting`**: User comments
- **`describing`**: Descriptions
- **`linking`**: Links to other resources

## Target Structures

The `target` field describes what is being annotated.

### Form 1: Simple String (entire resource)

```json
"target": "https://example.org/documents/doc-123"
```

### Form 2: Object with source only

```json
"target": {
  "source": "doc-123"
}
```

### Form 3: Object with source + selector (specific fragment)

```json
"target": {
  "source": "doc-123",
  "selector": [
    {
      "type": "TextPositionSelector",
      "start": 100,
      "end": 113
    },
    {
      "type": "TextQuoteSelector",
      "exact": "selected text"
    }
  ]
}
```

## Selectors

Semiont uses W3C selector arrays combining position and quote selectors for robustness.

### TextPositionSelector

Character positions from document start:

```json
{
  "type": "TextPositionSelector",
  "start": 100,
  "end": 120
}
```

### TextQuoteSelector

Exact text with optional context:

```json
{
  "type": "TextQuoteSelector",
  "exact": "selected text",
  "prefix": "the ",
  "suffix": " is"
}
```

### Selector Arrays

Every text annotation includes both for robustness:

```json
"selector": [
  {
    "type": "TextPositionSelector",
    "start": 100,
    "end": 120
  },
  {
    "type": "TextQuoteSelector",
    "exact": "selected text here"
  }
]
```

**Benefits:**

- TextPositionSelector: Fast lookup when document unchanged
- TextQuoteSelector: Recovery when document content shifts
- Prefix/suffix: Additional context for matching

See [W3C-SELECTORS.md](./W3C-SELECTORS.md) for complete selector documentation.

## JSON-LD Export

Semiont annotations are fully W3C-compliant and can be exported as standard JSON-LD:

```json
{
  "@context": "http://www.w3.org/ns/anno.jsonld",
  "type": "Annotation",
  "id": "https://semiont.app/annotations/anno-123",
  "motivation": "linking",
  "target": {
    "source": "https://semiont.app/documents/doc-123",
    "selector": [
      {
        "type": "TextPositionSelector",
        "start": 100,
        "end": 115
      },
      {
        "type": "TextQuoteSelector",
        "exact": "Albert Einstein"
      }
    ]
  },
  "body": [
    {
      "type": "TextualBody",
      "value": "Person",
      "purpose": "tagging"
    },
    {
      "type": "SpecificResource",
      "source": "https://semiont.app/documents/doc-einstein-bio",
      "purpose": "linking"
    }
  ],
  "creator": {
    "@type": "Person",
    "@id": "did:web:semiont.app:users:alice",
    "name": "Alice"
  },
  "created": "2025-10-24T10:30:00Z"
}
```

### Standards Compliance

- ✅ Full W3C Web Annotation Data Model compliance
- ✅ JSON-LD context from `http://www.w3.org/ns/anno.jsonld`
- ✅ Decentralized identifiers (DID:WEB) for every agent — people and software under one authority
- ✅ `generator` field on AI-produced annotations (W3C §3.2.1)
- ✅ `creator`, `generator` and `wasAttributedTo` derived from verified identities, never asserted
- ✅ Content-addressed document IDs for federation-readiness
- ✅ Interoperable with other W3C annotation tools

### Export Formats

Annotations can be exported in multiple formats:

- **JSON-LD**: Standard W3C format (`.jsonld` files)
- **JSON**: Without `@context` for simpler parsing
- **Annotation Collection**: Multiple annotations in W3C AnnotationCollection format

## References

- [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/)
- [W3C Web Annotation Vocabulary](https://www.w3.org/TR/annotation-vocab/)
- [JSON-LD 1.1](https://www.w3.org/TR/json-ld11/)
- [W3C Annotation Context](https://www.w3.org/ns/anno.jsonld)
- [DID:WEB Specification](https://w3c-ccg.github.io/did-method-web/)
