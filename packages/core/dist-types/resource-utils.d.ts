/**
 * Helper functions for working with W3C ResourceDescriptor
 */
import type { components } from './types';
import type { ResourceDescriptor } from './graph';
type Representation = components['schemas']['Representation'];
/**
 * Get the resource ID from @id property
 *
 * @id is always a bare ID (UUID), never a full URI.
 */
export declare function getResourceId(resource: ResourceDescriptor | undefined): string | undefined;
/**
 * Get the primary representation (first or only representation)
 */
export declare function getPrimaryRepresentation(resource: ResourceDescriptor | undefined): Representation | undefined;
/**
 * Get the media type from the primary representation
 */
export declare function getPrimaryMediaType(resource: ResourceDescriptor | undefined): string | undefined;
/**
 * Get the checksum from the primary representation
 */
export declare function getChecksum(resource: ResourceDescriptor | undefined): string | undefined;
/**
 * Get the language from the primary representation
 */
export declare function getLanguage(resource: ResourceDescriptor | undefined): string | undefined;
/**
 * Get the storage URI from the primary representation — the field's ONE home
 * (STORAGE-URI-ONE-HOME): bytes are a fact about a rendition, so their
 * location lives on the Representation, never on the descriptor. This is the
 * accessor every descriptor-holding read goes through; `undefined` means the
 * resource has no stored bytes.
 *
 * @param resource - ResourceDescriptor
 * @returns Storage URI or undefined
 */
export declare function getStorageUri(resource: ResourceDescriptor | undefined): string | undefined;
/**
 * Get creator agent from wasAttributedTo
 * Handles both single agent and array of agents
 *
 * @param resource - ResourceDescriptor
 * @returns First agent or undefined
 */
export declare function getCreator(resource: ResourceDescriptor | undefined): components['schemas']['Agent'] | undefined;
/**
 * Get derived-from URI
 * Handles both single URI and array of URIs
 *
 * @param resource - ResourceDescriptor
 * @returns First derivation URI or undefined
 */
export declare function getDerivedFrom(resource: ResourceDescriptor | undefined): string | undefined;
/**
 * Check if resource is archived (application-specific field)
 *
 * @param resource - ResourceDescriptor
 * @returns True if archived, false otherwise
 */
export declare function isArchived(resource: ResourceDescriptor | undefined): boolean;
/**
 * Get entity types from resource (application-specific field)
 *
 * @param resource - ResourceDescriptor
 * @returns Array of entity types, empty if not set
 */
export declare function getResourceEntityTypes(resource: ResourceDescriptor | undefined): string[];
/**
 * Check if resource is a draft (application-specific field)
 *
 * @param resource - ResourceDescriptor
 * @returns True if draft, false otherwise
 */
export declare function isDraft(resource: ResourceDescriptor | undefined): boolean;
/**
 * Map charset names to Node.js Buffer encoding names
 * Node.js Buffer.toString() supports: 'utf8', 'utf16le', 'latin1', 'base64', 'hex', 'ascii', 'binary', 'ucs2'
 *
 * @param charset - Charset name (e.g., "UTF-8", "ISO-8859-1", "Windows-1252")
 * @returns Node.js BufferEncoding
 */
export declare function getNodeEncoding(charset: string): BufferEncoding;
/**
 * Decode a representation buffer to string using the correct charset
 * Extracts charset from media type and uses appropriate encoding
 *
 * @param buffer - The raw representation data
 * @param mediaType - Media type with optional charset (e.g., "text/plain; charset=iso-8859-1")
 * @returns Decoded string
 *
 * @example
 * ```typescript
 * const content = decodeRepresentation(buffer, "text/plain; charset=utf-8");
 * const legacy = decodeRepresentation(buffer, "text/plain; charset=windows-1252");
 * ```
 */
export declare function decodeRepresentation(buffer: Buffer, mediaType: string): string;
export {};
