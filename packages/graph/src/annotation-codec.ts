/**
 * The annotation codec — the one module that decides how a W3C annotation
 * becomes stored properties and back.
 *
 * Every store keeps its own dialect (Cypher parameters, Gremlin
 * `.property()` chains, a Map) and its own way of flattening what the driver
 * hands back into a property bag. What none of them owns any more is the
 * SHAPE: the W3C envelope, which fields are required, how a selector is
 * serialized, how the body array is reconstructed from entity tags and a
 * linking source. Those lived in three near-verbatim copies that disagreed
 * in four places, and each disagreement was a bug — a resource-level
 * annotation came back carrying `selector: {}`, which is not a legal
 * selector, and a motivation-less row was silently relabelled `'linking'`.
 *
 * The codec manufactures nothing. Absence is stored as absence and read back
 * as absence, in both directions.
 */

import { annotationId as makeAnnotationId } from '@semiont/core';
import { getBodySource, getExactText, getTargetSelector, getTargetSource } from '@semiont/core';
import type { Annotation, AnnotationCategory, CreateAnnotationInternal } from '@semiont/core';

/**
 * A store's property bag, flattened. Producing this is the store's job (D3):
 * neo4j unwraps `node.properties` and its native temporals, the Gremlin
 * stores unwrap `[{value}]` lists. What the values MEAN is the codec's.
 */
export type AnnotationProperties = Record<string, string | undefined>;

type AnnotationTarget = Exclude<Annotation['target'], string>;
type AnnotationSelector = NonNullable<AnnotationTarget['selector']>;
type AnnotationBody = NonNullable<Annotation['body']>;

/**
 * The stored `type` property, which the category filters match on. It
 * restates the motivation, so it is derived from it here and nowhere else —
 * the three filters that used to hand-write the same mapping had drifted
 * into asking for a value no store ever wrote.
 */
export function storedAnnotationType(motivation: Annotation['motivation']): string {
  return motivation === 'highlighting' ? 'TextualBody' : 'SpecificResource';
}

/** The category a caller filters by, in the vocabulary the annotation stores. */
export function motivationForCategory(category: AnnotationCategory): Annotation['motivation'] {
  return category === 'highlight' ? 'highlighting' : 'linking';
}

/**
 * Mint the annotation a create request describes.
 *
 * `created` is a parameter rather than a `new Date()` here so the codec stays
 * pure — and so it is visible at each call site that the graph stamps its own
 * write time. `CreateAnnotationInternal` carries no timestamp, so the event's
 * own time does not reach this projection at all.
 */
export function buildAnnotation(input: CreateAnnotationInternal, created: string): Annotation {
  const annotation: Annotation = {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    id: makeAnnotationId(input.id),
    motivation: input.motivation,
    target: input.target,
    creator: input.creator,
    created,
  };
  if (input.body && (!Array.isArray(input.body) || input.body.length > 0)) {
    annotation.body = input.body;
  }
  return annotation;
}

/**
 * The annotation's stored properties. Entity tags are not among them — those
 * are edges, and the store writes them from `getEntityTypes(annotation)`.
 */
export function encodeAnnotation(annotation: Annotation): Record<string, string> {
  const selector = getTargetSelector(annotation.target);
  const bodySource = getBodySource(annotation.body);

  // `created` is optional on the wire but not in the store: a row without it
  // cannot be read back, so refuse to write one rather than mint a timestamp.
  const resourceId = getTargetSource(annotation.target);
  if (!resourceId) throw new Error(`Annotation ${annotation.id} has no target source`);
  if (!annotation.created) throw new Error(`Annotation ${annotation.id} has no created timestamp`);

  const props: Record<string, string> = {
    id: annotation.id,
    resourceId,
    type: storedAnnotationType(annotation.motivation),
    motivation: annotation.motivation,
    creator: JSON.stringify(annotation.creator),
    created: annotation.created,
  };

  if (selector) Object.assign(props, encodeSelector(selector));
  if (bodySource) props.source = bodySource;
  if (annotation.modified) props.modified = annotation.modified;
  if (annotation.generator) props.generator = JSON.stringify(annotation.generator);

  return props;
}

/**
 * The properties a selector contributes: its serialization, plus the quoted
 * text pulled out beside it. Targeted selector updates go through here too,
 * so no store decides on its own what a selector is called on disk.
 */
export function encodeSelector(selector: AnnotationSelector): Record<string, string> {
  const props: Record<string, string> = { selector: JSON.stringify(selector) };
  const exact = getExactText(selector);
  if (exact) props.exact = exact;
  return props;
}

/**
 * Rebuild the annotation from stored properties and the entity-tag edges the
 * store resolved separately.
 *
 * A field the properties do not carry is omitted, never invented: a
 * source-only target (legal since RESOURCE-LEVEL-ANCHOR) comes back with no
 * `selector`, and a row missing a required field fails loudly by name rather
 * than acquiring a default.
 */
export function decodeAnnotation(props: AnnotationProperties, entityTypes: string[] = []): Annotation {
  const id = props.id;
  if (!id) throw new Error('Annotation missing required field: id');

  const required = (key: string): string => {
    const value = props[key];
    if (!value) throw new Error(`Annotation ${id} missing required field: ${key}`);
    return value;
  };

  const resourceId = required('resourceId');
  const creator = JSON.parse(required('creator'));
  // The stored value is one of the wire vocabulary's, which the event that
  // produced it was validated against; the projection does not re-police it.
  const motivation = required('motivation') as Annotation['motivation'];
  const created = required('created');

  const body: AnnotationBody = [];
  for (const entityType of entityTypes) {
    if (entityType) body.push({ type: 'TextualBody', value: entityType, purpose: 'tagging' });
  }
  if (props.source) {
    body.push({ type: 'SpecificResource', source: props.source, purpose: 'linking' });
  }

  const selector = decodeSelector(props.selector);
  const target: AnnotationTarget = selector ? { source: resourceId, selector } : { source: resourceId };

  const annotation: Annotation = {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    id: makeAnnotationId(id),
    motivation,
    target,
    creator,
    created,
  };

  if (body.length > 0) annotation.body = body;
  if (props.modified) annotation.modified = props.modified;
  if (props.generator) {
    try {
      annotation.generator = JSON.parse(props.generator);
    } catch {
      // A corrupt generator is not worth failing the whole read over — the
      // annotation itself is intact, and provenance is advisory.
    }
  }

  return annotation;
}

/**
 * Rows written before RESOURCE-LEVEL-ANCHOR reached the stores hold `'{}'`
 * where a resource-level annotation has no selector at all. `{}` satisfies no
 * branch of the selector union, so it fails validation on the first round
 * trip through a validated channel — reading it back as absent is what makes
 * those rows harmless without a migration.
 */
function decodeSelector(raw: string | undefined): AnnotationSelector | undefined {
  if (!raw) return undefined;
  const parsed = JSON.parse(raw);
  if (!parsed || Object.keys(parsed).length === 0) return undefined;
  return parsed;
}
