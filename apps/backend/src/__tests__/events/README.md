# Event Store Tests

This directory contains tests for the event-sourced architecture implementation.

## Test Files

### `event-store.test.ts`

Comprehensive test suite for the event store implementation covering:

- **Initialization**: Directory structure creation with sharding
- **Event Emission**: Writing events to filesystem with proper sequencing
- **Event Chain Integrity**: Validating `prevEventHash` links between events
- **Event Querying**: Filtering and retrieving events from JSONL files
- **Projection Rebuilding**: Reconstructing document state from event streams

## Running Tests

```bash
# Run all event store tests
npm test -- event-store.test.ts

# Run with watch mode
npm run test:watch -- event-store.test.ts

# Run with coverage
npm run test:coverage -- event-store.test.ts
```

## Test Coverage

The test suite validates:

- ✅ Event store initialization with 4-hex sharding (65,536 shards)
- ✅ Event emission for all event types (document, highlight, reference, entity tag)
- ✅ Sequence number assignment and ordering
- ✅ prevEventHash chain integrity
- ✅ Event checksum calculation and validation
- ✅ JSONL file creation and reading
- ✅ Shard directory structure (`shards/xx/yy/documents/{doc-id}/`)
- ✅ Event filtering by type, user, timestamp
- ✅ Projection rebuilding from events
- ✅ Document state reconstruction (name, content, highlights, references, entity tags)
- ✅ Archive/unarchive handling in materialized views

## Architecture

Events are stored in the filesystem:
```
data/events/
└── shards/
    ├── 00/
    │   ├── 00/
    │   │   └── documents/
    │   │       └── doc-sha256:abc123/
    │   │           └── events-000000-1234567890.jsonl
    │   └── 01/
    └── ff/
        └── ff/
```

Each event includes:
- **Event data**: `id`, `type`, `documentId`, `userId`, `timestamp`, `payload`
- **Metadata**: `sequenceNumber`, `streamPosition`, `checksum`, `prevEventHash`
- **Optional**: `signature` for federation (unused in MVP)

## Federation-Ready Design

- Content-addressed document IDs: `doc-sha256:{hash}`
- Decentralized Identity: `did:web:org.com:users:alice`
- Event chain integrity via `prevEventHash`
- Signature fields prepared for future cross-org verification