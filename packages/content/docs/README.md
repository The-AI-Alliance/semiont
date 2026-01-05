# @semiont/content Documentation

Documentation for the content-addressed storage package.

## Topics

- **[Content Addressing](content-addressing.md)** - How content-addressed storage works
- **[Sharding Strategy](sharding-strategy.md)** - Directory distribution (65,536 shards)
- **[MIME Types](mime-types.md)** - Media type handling (80+ types)
- **[Architecture](architecture.md)** - Design principles and implementation

## Quick Reference

### Content Addressing
- SHA-256 checksums as identifiers
- Automatic deduplication
- Idempotent operations
- Integrity verification

### Sharding
- Two-level directory structure (4 hex chars)
- Balanced distribution across 65,536 shards
- O(1) lookup performance
- Path: `{mediaType}/{ab}/{cd}/rep-{checksum}.{ext}`

### MIME Types
- 80+ supported types with proper extensions
- Forward slash encoding: `/` → `~1`
- Charset preserved in metadata, stripped from paths
- Unknown types default to `.dat`

### Design
- Framework-independent (no web dependencies)
- Interface-based (supports multiple backends)
- Simple configuration (just basePath)
- Full TypeScript support

From [../src/representation-store.ts](../src/representation-store.ts): Core implementation.
From [../src/mime-extensions.ts](../src/mime-extensions.ts): MIME type mappings.

## External References

- Content Addressing: [IPFS Docs](https://docs.ipfs.tech/concepts/content-addressing/)
- SHA-256: [NIST FIPS 180-4](https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.180-4.pdf)
- MIME Types: [RFC 2045](https://datatracker.ietf.org/doc/html/rfc2045)
- JSON Pointer: [RFC 6901](https://datatracker.ietf.org/doc/html/rfc6901)
