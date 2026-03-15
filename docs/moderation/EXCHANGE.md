# Linked Data Exchange

This guide covers how to export and import knowledge base data as JSON-LD Linked Data. The linked data format captures the current state of resources, annotations, and content — it is designed for data sharing and interoperability rather than disaster recovery.

**Related guides**: [Backup & Restore](../administration/BACKUP.md) | [Architecture](../ARCHITECTURE.md)

## Overview

The linked data exchange format (`semiont-linked-data`) exports each resource as a self-describing JSON-LD document with [W3C Web Annotation](https://www.w3.org/TR/annotation-model/) compliant annotations. This makes the data portable and interpretable by standard Linked Data tooling.

Key characteristics:

- **Current state only** — no event history is preserved
- **Lossy** — original resource IDs are not preserved on import (new IDs are assigned)
- **Standards-based** — uses Schema.org, W3C Web Annotation, Dublin Core, and PROV-O vocabularies
- **Content included** — all content blobs are bundled in the archive

This format requires the **moderator** or **admin** role.

## GUI: Export and Import

The Moderation section includes a **Linked Data** page at `/moderate/linked-data`.

### Exporting

1. Navigate to **Moderation → Linked Data**
2. Click **Export**
3. The browser downloads a `.tar.gz` archive containing all resources and their content

By default, archived resources are excluded from the export.

### Importing

1. Navigate to **Moderation → Linked Data**
2. Drop or select a `.tar.gz` linked data archive
3. Review the file preview
4. Click **Import** and confirm

The import creates new resources from the archive. Progress is reported in phases: entity types, resources, annotations, and completion.

**Note**: Import adds data to the existing knowledge base. It does not replace or overwrite existing resources.

## CLI: Export and Import

```bash
# Export current state as JSON-LD
semiont export --out export.tar.gz

# Include archived resources
semiont export --include-archived --out full-export.tar.gz

# Import from a JSON-LD archive
semiont import --file export.tar.gz

# Specify user identity for imported resources
semiont import --file export.tar.gz --user-id did:web:example.com:users:alice
```

When no `--user-id` is provided, the import defaults to `did:web:localhost:users:{system-user}`.

## Archive Format

A linked data export is a gzip-compressed POSIX tar archive:

```
semiont-linked-data-{timestamp}.tar.gz
├── .semiont/
│   ├── manifest.jsonld
│   └── resources/
│       ├── {resourceId}.jsonld
│       ├── {resourceId}.jsonld
│       └── ...
├── {checksum}.md
├── {checksum}.pdf
└── ...
```

### Manifest (`.semiont/manifest.jsonld`)

A JSON-LD document describing the archive contents:

```json
{
  "@context": {
    "semiont": "https://semiont.org/vocab/",
    "schema": "https://schema.org/",
    "dct": "http://purl.org/dc/terms/",
    "prov": "http://www.w3.org/ns/prov#",
    "void": "http://rdfs.org/ns/void#"
  },
  "@type": "void:Dataset",
  "semiont:format": "semiont-linked-data",
  "semiont:version": 1,
  "dct:created": "2026-03-15T12:00:00.000Z",
  "prov:wasGeneratedBy": {
    "@type": "prov:Activity",
    "prov:used": "https://semiont.example.com"
  },
  "semiont:entityTypes": ["Person", "Organization", "Location"],
  "void:entities": 42
}
```

| Field | Description |
|-------|-------------|
| `semiont:format` | Always `"semiont-linked-data"` |
| `semiont:version` | Format version (currently `1`) |
| `dct:created` | ISO 8601 timestamp of export |
| `prov:wasGeneratedBy` | Provenance — the source Semiont instance URL |
| `semiont:entityTypes` | All entity types defined in the knowledge base |
| `void:entities` | Number of resources in the archive |

### Resource Documents (`.semiont/resources/{id}.jsonld`)

Each resource is a JSON-LD document combining Schema.org, W3C Web Annotation, and Semiont vocabularies. Here is a complete example:

```json
{
  "@context": [
    "https://schema.org/",
    "http://www.w3.org/ns/anno.jsonld",
    {
      "semiont": "https://semiont.org/vocab/",
      "entityTypes": "semiont:entityTypes",
      "creationMethod": "semiont:creationMethod",
      "archived": "semiont:archived",
      "representations": { "@id": "semiont:representations", "@container": "@set" },
      "annotations": { "@id": "semiont:annotations", "@container": "@set" }
    }
  ],
  "@id": "https://semiont.example.com/resources/4feadd89-1a2b-3c4d-5e6f-7890abcdef12",
  "@type": "DigitalDocument",
  "name": "Prometheus Bound",
  "dateCreated": "2026-03-10T14:30:00.000Z",
  "dateModified": "2026-03-12T09:15:00.000Z",
  "inLanguage": "en",
  "encodingFormat": "text/markdown",
  "creationMethod": "ui",
  "entityTypes": ["Person", "Location"],
  "representations": [
    {
      "@type": "schema:MediaObject",
      "encodingFormat": "text/markdown",
      "contentSize": 4208,
      "sha256": "519d39ca8e7b2f1a3d4c5b6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a",
      "name": "519d39ca8e7b2f1a3d4c5b6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a.md",
      "inLanguage": "en"
    }
  ],
  "annotations": [
    {
      "@context": "http://www.w3.org/ns/anno.jsonld",
      "id": "https://semiont.example.com/annotations/a1b2c3d4-5e6f-7890-abcd-ef1234567890",
      "type": "Annotation",
      "motivation": "highlighting",
      "created": "2026-03-11T10:00:00.000Z",
      "creator": {
        "type": "Person",
        "id": "did:web:example.com:users:alice"
      },
      "target": {
        "source": "https://semiont.example.com/resources/4feadd89-1a2b-3c4d-5e6f-7890abcdef12",
        "selector": {
          "type": "TextQuoteSelector",
          "exact": "Prometheus",
          "prefix": "chained ",
          "suffix": " speaks"
        }
      },
      "body": {
        "type": "TextualBody",
        "value": "The Titan who stole fire from the gods",
        "format": "text/plain"
      }
    }
  ]
}
```

Key fields:

| Field | Source | Description |
|-------|--------|-------------|
| `@id` | Schema.org | Full resource URI (hydrated from bare ID) |
| `@type` | Schema.org | Document type (e.g., `DigitalDocument`) |
| `name` | Schema.org | Resource title |
| `dateCreated`, `dateModified` | Schema.org | Timestamps |
| `inLanguage` | Schema.org | Language code from primary representation |
| `encodingFormat` | Schema.org | MIME type from primary representation |
| `creationMethod` | Semiont | How the resource was created (`ui`, `api`, `import`, `generation`) |
| `entityTypes` | Semiont | Entity type tags assigned to this resource |
| `archived` | Semiont | Whether the resource is archived |
| `representations` | Semiont | Content files as `schema:MediaObject` with SHA-256 checksums |
| `annotations` | W3C Web Annotation | Annotations with hydrated URIs |

### Content Blobs (root level)

Content-addressed files at the archive root: `{checksum}.{ext}` (e.g., `519d39ca...6a.md`). The checksum in each resource's `representations[].sha256` field maps to the corresponding file. The file extension is derived from the MIME type.

## URI Handling

During export, bare internal IDs are hydrated into full HTTP IRIs for W3C compliance:

- Resource IDs: `4feadd89...` → `https://host/resources/4feadd89...`
- Annotation IDs: `a1b2c3d4...` → `https://host/annotations/a1b2c3d4...`
- Annotation targets and body sources are similarly hydrated

During import, URIs are stripped back to bare IDs. Since new resource IDs are assigned on import, annotation targets are rewritten to point to the newly created resource.

## Comparison with Full Backup

| | Linked Data | Full Backup |
|---|---|---|
| **Format** | `semiont-linked-data` | `semiont-backup` |
| **Scope** | Current state | Complete event history |
| **Lossless** | No | Yes |
| **IDs preserved** | No (new IDs on import) | Yes (events replayed as-is) |
| **Event history** | Not included | Included |
| **Hash chain** | N/A | Verified on restore |
| **Interoperable** | Yes (JSON-LD, W3C) | No (Semiont-specific) |
| **Access** | Moderator | Admin |
| **Use case** | Sharing, portability | Disaster recovery, migration |

For full backup and restore, see [Backup & Restore](../administration/BACKUP.md).
