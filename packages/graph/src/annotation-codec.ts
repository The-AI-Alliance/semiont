/**
 * The annotation codec — the one module that decides how a W3C annotation
 * becomes stored properties and back.
 *
 * Every store keeps its own dialect (Cypher parameters, Gremlin
 * `.property()` chains, a Map) and its own way of flattening what the driver
 * hands back into a property bag. What none of them owns is the
 * SHAPE: the W3C envelope, which fields are required, how a selector is
 * serialized, how the body array is reconstructed from entity tags and a
 * linking source. A copy per store drifts, and each disagreement is a bug —
 * a resource-level annotation coming back with `selector: {}`, which is not
 * a legal selector, or a motivation-less row silently relabelled `'linking'`.
 *
 * The codec manufactures nothing. Absence is stored as absence and read back
 * as absence, in both directions.
 *
 * No store in this package writes: the graph's writer is the Weaver, whose
 * codec is `semiont_graph`'s, and specs/src/graph/codec-cases.json holds the
 * two to one answer. The encoding half is here for `intendedGraphAnnotation`,
 * which says what a reader is to read back.
 */

import { annotationId as makeAnnotationId, resourceId as makeResourceId } from '@semiont/core';
import { getBodySource, getExactText, getTargetSelector, getTargetSource } from '@semiont/core';
import { getEntityTypes } from '@semiont/core';
import type { Annotation, AnnotationCategory } from '@semiont/core';

/**
 * A store's property bag, flattened. Producing this is the store's job:
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
 * a filter that hand-writes the mapping can drift into asking for a value
 * no store writes.
 */
export function storedAnnotationType(motivation: Annotation['motivation']): string {
  return motivation === 'highlighting' ? 'TextualBody' : 'SpecificResource';
}

/** The category a caller filters by, in the vocabulary the annotation stores. */
export function motivationForCategory(category: AnnotationCategory): Annotation['motivation'] {
  return category === 'highlight' ? 'highlighting' : 'linking';
}

type Agent = NonNullable<Annotation['creator']>;

/**
 * An agent as the graph holds it: who, and not what a person is called.
 *
 * A person's name is the directory's. The record's annotation carries none
 * for the one who asked; the Archivist joins it onto every read from the
 * people projection, where a person can change it. A graph that stored the
 * name would hold a copy that goes stale, and a check of the graph against a
 * read would call every annotation by a named person wrong. Software is not
 * named on a read: its agent is stored as the record gives it.
 */
function storedAgent(agent: Agent): Agent {
  if (agent['@type'] !== 'Person') return agent;
  const { name: _theDirectorys, ...who } = agent;
  return who;
}

/**
 * The annotation's stored properties. Entity tags are not among them — those
 * are edges, and the store writes them from `getEntityTypes(annotation)`.
 */
export function encodeAnnotation(annotation: Annotation): Record<string, string> {
  const selector = getTargetSelector(annotation.target);
  const bodySource = getBodySource(annotation.body);

  const resourceId = getTargetSource(annotation.target);
  if (!resourceId) throw new Error(`Annotation ${annotation.id} has no target source`);

  const props: Record<string, string> = {
    id: annotation.id,
    resourceId,
    type: storedAnnotationType(annotation.motivation),
    motivation: annotation.motivation,
    creator: JSON.stringify(annotation.creator === undefined ? undefined : storedAgent(annotation.creator)),
    created: annotation.created,
  };

  if (selector) Object.assign(props, encodeSelector(selector));
  if (bodySource) props.source = bodySource;
  if (annotation.modified) props.modified = annotation.modified;
  if (annotation.generator) {
    props.generator = JSON.stringify(
      Array.isArray(annotation.generator) ? annotation.generator.map(storedAgent) : storedAgent(annotation.generator),
    );
  }

  return props;
}

/**
 * The properties a selector contributes: its serialization, plus the quoted
 * text pulled out beside it.
 */
function encodeSelector(selector: AnnotationSelector): Record<string, string> {
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
 * source-only target (legal: a whole resource is a first-class annotation
 * target) comes back with no `selector`, and a row missing a required field
 * fails loudly by name rather than acquiring a default.
 */
export function decodeAnnotation(props: AnnotationProperties, entityTypes: string[] = []): Annotation {
  const id = props.id;
  if (!id) throw new Error('Annotation missing required field: id');

  const required = (key: string): string => {
    const value = props[key];
    if (!value) throw new Error(`Annotation ${id} missing required field: ${key}`);
    return value;
  };

  const resourceId = makeResourceId(required('resourceId'));
  const creator = JSON.parse(required('creator'));
  // The stored value is one of the wire vocabulary's, which the event that
  // produced it was validated against; the projection does not re-police it.
  const motivation = required('motivation') as Annotation['motivation'];
  const created = required('created');

  // Tags are edges, and a store answers edges in no promised order. The
  // codec states one, so that two readings of the same tags are the same
  // annotation and a check of the graph never mistakes order for content.
  const body: AnnotationBody = [];
  for (const entityType of [...entityTypes].sort()) {
    if (entityType) body.push({ type: 'TextualBody', value: entityType, purpose: 'tagging' });
  }
  if (props.source) {
    body.push({ type: 'SpecificResource', source: makeResourceId(props.source), purpose: 'linking' });
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
 * A stored row may hold `'{}'` where a resource-level annotation has no
 * selector at all — the encoder writes none, but such rows exist. `{}`
 * satisfies no branch of the selector union, so it fails validation on the
 * first round trip through a validated channel — reading it back as absent
 * is what makes those rows harmless without a migration.
 */
function decodeSelector(raw: string | undefined): AnnotationSelector | undefined {
  if (!raw) return undefined;
  const parsed = JSON.parse(raw);
  if (!parsed || Object.keys(parsed).length === 0) return undefined;
  return parsed;
}

/**
 * What the graph is SUPPOSED to hold for this annotation — the codec's own
 * statement of it, obtained by round-tripping through both halves.
 *
 * The graph is a purpose-built projection, not a copy of the views: it stores
 * what graph queries need and nothing else. `wasAttributedTo`, for instance,
 * rides on almost every annotation in the log and the encoder deliberately
 * writes none of it. So "is the graph correct?" cannot be answered by comparing
 * it to a view — only by comparing it to what this module says it should be.
 *
 * Callers get a value scoped to exactly the fields the encoder writes, in the
 * decoded shape, free of any store's physical dialect. Widen or narrow the
 * encoder and this follows automatically; there is no second list to maintain.
 */
export function intendedGraphAnnotation(annotation: Annotation): Annotation {
  return decodeAnnotation(encodeAnnotation(annotation), getEntityTypes(annotation));
}
