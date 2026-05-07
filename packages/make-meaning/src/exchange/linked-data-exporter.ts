/**
 * Linked Data Exporter
 *
 * Produces a JSON-LD tar.gz archive from the current state of the knowledge base.
 * Reads materialized views (not the event log) for a fast, current-state export.
 *
 * Archive structure:
 *   .semiont/manifest.jsonld                - JSON-LD manifest with format metadata
 *   .semiont/resources/{resourceId}.jsonld   - One JSON-LD document per resource
 *   {checksum}.{ext}                        - Content blobs (root level)
 */

import type { Writable } from 'node:stream';
import type { Logger } from '@semiont/core';
import type { components } from '@semiont/core';
import { getExtensionForMimeType } from '@semiont/content';
import { writeTarGz, type TarEntry } from './tar';
import {
  LINKED_DATA_FORMAT,
  FORMAT_VERSION,
  type LinkedDataManifest,
} from './manifest';

import type { ResourceDescriptor } from '@semiont/core';
type Representation = components['schemas']['Representation'];
import type { Annotation } from '@semiont/core';

/** Subset of ViewStorage used by the linked-data exporter. */
export interface LinkedDataViewReader {
  getAll(): Promise<Array<{
    resource: ResourceDescriptor;
    annotations: { annotations: Annotation[] };
  }>>;
}

/**
 * Hydrated output shape: identifier fields are full URIs rather than
 * bare branded ids. Produced only when serialising to the JSON-LD wire
 * format; do not consume inside the domain (use `Annotation` /
 * `ResourceDescriptor` instead).
 */
type HydratedAnnotation = Omit<Annotation, 'id' | 'target'> & {
  id: string;
  target: Annotation['target'];
};

/** Subset of WorkingTreeStore used by the linked-data exporter. */
export interface LinkedDataContentReader {
  retrieve(storageUri: string): Promise<Buffer>;
}

export interface LinkedDataExporterOptions {
  views: LinkedDataViewReader;
  content: LinkedDataContentReader;
  sourceUrl: string;
  entityTypes: string[];
  includeArchived?: boolean;
  logger?: Logger;
}

const SEMIONT_CONTEXT = [
  'https://schema.org/',
  'http://www.w3.org/ns/anno.jsonld',
  {
    'semiont': 'https://semiont.org/vocab/',
    'entityTypes': 'semiont:entityTypes',
    'creationMethod': 'semiont:creationMethod',
    'archived': 'semiont:archived',
    'representations': { '@id': 'semiont:representations', '@container': '@set' },
    'annotations': { '@id': 'semiont:annotations', '@container': '@set' },
  },
];

const MANIFEST_CONTEXT: Record<string, string> = {
  'semiont': 'https://semiont.org/vocab/',
  'schema': 'https://schema.org/',
  'dct': 'http://purl.org/dc/terms/',
  'prov': 'http://www.w3.org/ns/prov#',
  'void': 'http://rdfs.org/ns/void#',
};

/**
 * Hydrate bare IDs into full W3C-compliant URIs for JSON-LD export.
 *
 * Internally Semiont stores bare IDs (UUIDs). For linked-data export we
 * construct full HTTP IRIs so the output is valid JSON-LD / W3C Web Annotation.
 */
function hydrateAnnotation(annotation: Annotation, baseUrl: string): HydratedAnnotation {
  const hydrated = { ...annotation } as HydratedAnnotation;

  // annotation.id: bare annotation ID → full URI
  if (hydrated.id && !hydrated.id.startsWith('http')) {
    hydrated.id = `${baseUrl}/annotations/${hydrated.id}`;
  }

  // annotation.target
  if (typeof hydrated.target === 'string') {
    if (!hydrated.target.startsWith('http')) {
      hydrated.target = `${baseUrl}/resources/${hydrated.target}`;
    }
  } else if (hydrated.target && typeof hydrated.target === 'object') {
    const target = { ...hydrated.target };
    if (target.source && !target.source.startsWith('http')) {
      target.source = `${baseUrl}/resources/${target.source}`;
    }
    hydrated.target = target;
  }

  // annotation.body — single or array of SpecificResource with source
  hydrated.body = hydrateBody(hydrated.body, baseUrl);

  return hydrated;
}

function hydrateBody(body: Annotation['body'], baseUrl: string): Annotation['body'] {
  if (Array.isArray(body)) {
    return body.map((b) => hydrateBodyItem(b, baseUrl));
  }
  return hydrateBodyItem(body, baseUrl);
}

function hydrateBodyItem<T>(item: T, baseUrl: string): T {
  if (item && typeof item === 'object' && 'source' in item) {
    const source = (item as { source: string }).source;
    if (typeof source === 'string' && !source.startsWith('http')) {
      return { ...item, source: `${baseUrl}/resources/${source}` };
    }
  }
  return item;
}

/**
 * Export the knowledge base as a JSON-LD tar.gz archive.
 */
export async function exportLinkedData(
  options: LinkedDataExporterOptions,
  output: Writable,
): Promise<LinkedDataManifest> {
  const { views, content, sourceUrl, entityTypes, includeArchived, logger } = options;

  const allViews = await views.getAll();
  const resourceViews = includeArchived
    ? allViews
    : allViews.filter((v) => !v.resource.archived);

  logger?.info('Linked data export: enumerating resources', { count: resourceViews.length });

  // Collect storageUris + mediaTypes for content blobs
  const contentRefs = new Map<string, string>(); // storageUri -> mediaType
  for (const view of resourceViews) {
    collectContentRefsFromResource(view.resource, contentRefs);
  }

  // Read all content blobs
  const contentBlobs = new Map<string, { data: Awaited<ReturnType<LinkedDataContentReader['retrieve']>>; ext: string }>();
  for (const [storageUri, mediaType] of contentRefs) {
    try {
      const data = await content.retrieve(storageUri);
      const ext = getExtensionForMimeType(mediaType);
      contentBlobs.set(storageUri, { data, ext });
    } catch (err) {
      logger?.warn('Failed to retrieve content blob', { storageUri, error: String(err) });
    }
  }

  // Build manifest
  const manifest: LinkedDataManifest = {
    '@context': MANIFEST_CONTEXT,
    '@type': 'void:Dataset',
    'semiont:format': LINKED_DATA_FORMAT,
    'semiont:version': FORMAT_VERSION,
    'dct:created': new Date().toISOString(),
    'prov:wasGeneratedBy': {
      '@type': 'prov:Activity',
      'prov:used': sourceUrl,
    },
    'semiont:entityTypes': entityTypes,
    'void:entities': resourceViews.length,
  };

  // Stream tar entries
  async function* generateEntries(): AsyncIterable<TarEntry> {
    // 1. Manifest
    yield {
      name: '.semiont/manifest.jsonld',
      data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
    };

    // 2. Per-resource JSON-LD documents
    for (const view of resourceViews) {
      const resourceId = view.resource['@id'];
      const jsonld = buildResourceJsonLd(view.resource, view.annotations.annotations, sourceUrl);
      yield {
        name: `.semiont/resources/${resourceId}.jsonld`,
        data: Buffer.from(JSON.stringify(jsonld, null, 2), 'utf8'),
      };
    }

    // 3. Content blobs stored as {checksum}.{ext} at root level
    for (const [storageUri, { data, ext }] of contentBlobs) {
      const blobPath = storageUri.startsWith('file://') ? storageUri.slice(7) : storageUri;
      yield { name: `${blobPath}${ext}`, data };
    }
  }

  await writeTarGz(generateEntries(), output);

  logger?.info('Linked data export complete', {
    resources: resourceViews.length,
    blobs: contentBlobs.size,
  });

  return manifest;
}

/**
 * Build a JSON-LD document for a single resource with its annotations.
 * Hydrates bare IDs into full W3C-compliant URIs using sourceUrl.
 */
function buildResourceJsonLd(
  resource: ResourceDescriptor,
  annotations: Annotation[],
  sourceUrl: string,
): Record<string, unknown> {
  const resourceId = resource['@id'];
  const resourceUri = resourceId.startsWith('http')
    ? resourceId
    : `${sourceUrl}/resources/${resourceId}`;

  const doc: Record<string, unknown> = {
    '@context': SEMIONT_CONTEXT,
    '@id': resourceUri,
    '@type': resource['@type'] ?? 'DigitalDocument',
    'name': resource.name,
  };

  if (resource.dateCreated) doc['dateCreated'] = resource.dateCreated;
  if (resource.dateModified) doc['dateModified'] = resource.dateModified;
  if (resource.description) doc['description'] = resource.description;

  // Language and format from primary representation
  const reps = normalizeRepresentations(resource.representations);
  if (reps.length > 0) {
    const primary = reps[0];
    if (primary.language) doc['inLanguage'] = primary.language;
    if (primary.mediaType) doc['encodingFormat'] = primary.mediaType;
  }

  // Application-specific fields via semiont: vocabulary
  if (resource.creationMethod) doc['creationMethod'] = resource.creationMethod;
  if (resource.entityTypes && resource.entityTypes.length > 0) doc['entityTypes'] = resource.entityTypes;
  if (resource.archived) doc['archived'] = resource.archived;

  // W3C PROV fields
  if (resource.wasDerivedFrom) doc['wasDerivedFrom'] = resource.wasDerivedFrom;
  if (resource.wasAttributedTo) doc['wasAttributedTo'] = resource.wasAttributedTo;

  // Schema.org fields
  if (resource.sameAs && resource.sameAs.length > 0) doc['sameAs'] = resource.sameAs;
  if (resource.isPartOf && resource.isPartOf.length > 0) doc['isPartOf'] = resource.isPartOf;
  if (resource.hasPart && resource.hasPart.length > 0) doc['hasPart'] = resource.hasPart;

  // Representations as schema:MediaObject
  if (reps.length > 0) {
    doc['representations'] = reps.map((rep) => {
      const mediaObj: Record<string, unknown> = {
        '@type': 'schema:MediaObject',
        'encodingFormat': rep.mediaType,
      };
      if (rep.byteSize !== undefined) mediaObj['contentSize'] = rep.byteSize;
      if (rep.checksum) {
        const rawChecksum = rep.checksum.startsWith('sha256:')
          ? rep.checksum.slice(7)
          : rep.checksum;
        mediaObj['sha256'] = rawChecksum;
        const ext = getExtensionForMimeType(rep.mediaType);
        mediaObj['name'] = `${rawChecksum}${ext}`;
      }
      if (rep.language) mediaObj['inLanguage'] = rep.language;
      return mediaObj;
    });
  }

  // Annotations — hydrate bare IDs into full URIs for W3C compliance
  if (annotations.length > 0) {
    doc['annotations'] = annotations.map((ann) => hydrateAnnotation(ann, sourceUrl));
  }

  return doc;
}

/**
 * Normalize representations field which can be a single object or array.
 */
function normalizeRepresentations(
  reps: ResourceDescriptor['representations'],
): Representation[] {
  if (!reps) return [];
  if (Array.isArray(reps)) return reps;
  return [reps];
}

/**
 * Collect storageUri + mediaType from a resource for content export.
 */
function collectContentRefsFromResource(
  resource: ResourceDescriptor,
  refs: Map<string, string>,
): void {
  if (resource.storageUri) {
    const reps = normalizeRepresentations(resource.representations);
    const mediaType = reps[0]?.mediaType ?? 'application/octet-stream';
    refs.set(resource.storageUri, mediaType);
  }
}
