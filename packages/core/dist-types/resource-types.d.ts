/**
 * Resource input/output types
 */
import type { components } from './types';
/**
 * What the byte door reports about bytes it just stored. A projection of the
 * specced Representation — drop a field there and this stops compiling.
 */
export type StoredResource = Required<Pick<components['schemas']['Representation'], 'storageUri' | 'checksum' | 'byteSize' | 'created'>>;
export interface UpdateResourceInput {
    name?: string;
    entityTypes?: string[];
    archived?: boolean;
}
export interface ResourceFilter {
    entityTypes?: string[];
    search?: string;
    archived?: boolean;
    limit?: number;
    offset?: number;
}
