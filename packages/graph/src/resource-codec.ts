/**
 * The resource codec — the one module that decides how a resource becomes
 * stored properties and back.
 *
 * Every store keeps its own dialect: Cypher sets a map on a node, Gremlin
 * chains `.property()` calls and keeps a list as a JSON string. What none of
 * them owns is WHICH properties a resource has and what each is called. The
 * stores once each decided that for themselves, and decided differently: one
 * media type was `format` in one store, `contentType` in another and
 * `mediaType` in a third.
 *
 * The graph is a purpose-built projection, not a copy of the views. It holds
 * of a resource what its queries need: the name, entity types and storage
 * location a search matches; the format and the date a listing reports and
 * orders by; whether it is archived; and who it is by.
 *
 * The codec manufactures nothing. A resource with no date, no attribution or
 * no checksum is refused on the way in, by the field's name, rather than
 * stored and found unreadable on the way out.
 */

import { getPrimaryRepresentation, getResourceEntityTypes, getResourceId, resourceId as makeResourceId } from '@semiont/core';
import type { ResourceDescriptor } from '@semiont/core';

/** A resource's stored properties, in the codec's names and types. */
export interface ResourceProperties {
  id: string;
  name: string;
  entityTypes: string[];
  /** The media type of the resource's primary representation. */
  format: string;
  archived: boolean;
  /** When the record says the resource was created. */
  created: string;
  /** Who the resource is by (`wasAttributedTo`), as JSON. */
  creator: string;
  contentChecksum: string;
  storageUri?: string;
}

/**
 * What a store hands back, flattened to the codec's names. Producing it is the
 * store's job; every property is optional here because a row is not to be
 * trusted until `decodeResource` has checked it.
 */
export type StoredResourceProperties = { [K in keyof ResourceProperties]?: ResourceProperties[K] | null };

export function encodeResource(resource: ResourceDescriptor): ResourceProperties {
  const id = getResourceId(resource);
  if (!id) throw new Error('Resource missing required field: @id');

  const representation = getPrimaryRepresentation(resource);
  if (!representation) throw new Error(`Resource ${id} missing required field: representations`);

  const refuse = (field: string): never => {
    throw new Error(`Resource ${id} missing required field: ${field}`);
  };

  const props: ResourceProperties = {
    id,
    name: resource.name || refuse('name'),
    entityTypes: getResourceEntityTypes(resource),
    format: representation.mediaType || refuse('representations.mediaType'),
    archived: resource.archived === true,
    created: resource.dateCreated || refuse('dateCreated'),
    creator: JSON.stringify(resource.wasAttributedTo ?? refuse('wasAttributedTo')),
    contentChecksum: representation.checksum || refuse('representations.checksum'),
  };
  if (representation.storageUri) props.storageUri = representation.storageUri;
  return props;
}

export function decodeResource(props: StoredResourceProperties): ResourceDescriptor {
  const id = props.id;
  if (!id) throw new Error('Resource missing required field: id');

  const required = <K extends keyof ResourceProperties>(key: K): ResourceProperties[K] => {
    const value = props[key];
    if (value === undefined || value === null || value === '') {
      throw new Error(`Resource ${id} missing required field: ${key}`);
    }
    return value;
  };

  const storageUri = props.storageUri;
  return {
    '@context': 'https://schema.org/',
    '@id': makeResourceId(id),
    name: required('name'),
    entityTypes: required('entityTypes'),
    representations: [{
      mediaType: required('format'),
      checksum: required('contentChecksum'),
      rel: 'original',
      // The URI lives on the representation, its one home.
      ...(storageUri ? { storageUri } : {}),
    }],
    archived: required('archived'),
    dateCreated: required('created'),
    wasAttributedTo: JSON.parse(required('creator')),
  };
}
