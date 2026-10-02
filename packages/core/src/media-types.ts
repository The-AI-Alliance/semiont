/**
 * Media-type registry for Semiont
 *
 * One supported-types list, capability-tiered, keyed by the spec's
 * SupportedMediaType enum. The rows are specs/src/media-types/registry.json's,
 * generated; this module is the questions asked of them. Admission (registry
 * membership) is the create/yield gate: every member is storable, nameable,
 * and uploadable.
 * The curated capabilities say what more the system can do with a type:
 *
 * - `render`      — which viewer the UI mounts ('none' → metadata + download)
 * - `anchoring`   — which annotation model applies: character-offset text
 *                   selectors vs spatial geometry (PDFs are spatial)
 * - `textSource`  — WHERE a type's text comes from: decoded from its own bytes,
 *                   or derived by reading them ('none' → skip embedding, never
 *                   mojibake). Named `extractText` until READ-VS-EXTRACT P3,
 *                   which called decoding an extraction — the conflation that
 *                   let a worker OCR PDFs for four months (#739)
 * - `authorable`  — offered in the compose editor's format dropdown
 * - `uploadable`  — big tent: true for every registry member
 * - `generatable` — the generation worker can produce it as a yield artifact
 *
 * Capabilities are orthogonal strategies, not a ladder: images render but
 * yield no text; PDFs yield text but aren't authorable. A "tier" is a
 * derived reading, not a stored fact.
 *
 * Questions ANSWERABLE from those rows get a helper, never a row of their own —
 * `isAnnotatable` reads `anchoring`, and a second stored field would be a fact
 * that can contradict the one it was derived from.
 *
 * Import-leniency invariant: restore/import preserves archive mediaTypes
 * verbatim, so "every stored mediaType is registry-valid" holds only for
 * content that entered through the validated create/yield gate. No code
 * reading a stored mediaType may assume `capabilitiesOf()` succeeds — the
 * `undefined` branch is mandatory wherever stored types are read.
 */

import type { components } from './types';
import {
  EXTENSION_ALIASES,
  MEDIA_TYPE_ROWS,
  type AnchoringModel,
  type RenderMode,
  type TextSource,
} from './generated/media-types';

export type SupportedMediaType = components['schemas']['SupportedMediaType'];
export type { AnchoringModel, RenderMode, TextSource };

export interface MediaTypeCapabilities {
  /** Canonical file extension, with leading dot. */
  extension: `.${string}`;
  /** UI display name. */
  label: string;
  render: RenderMode;
  anchoring: AnchoringModel;
  textSource: TextSource;
  authorable: boolean;
  uploadable: boolean;
  /** Whether the generation worker can produce this type as a yield artifact.
   *  Gate for `outputMediaType` — unsupported requests fail loudly, never
   *  fall back to markdown under a mislabeled format. */
  generatable: boolean;
}

/**
 * The registry: specs/src/media-types/registry.json, which every SDK
 * generates from. `satisfies Record<SupportedMediaType, …>` holds the table to
 * the spec's enum in this language too: a type in one and not the other is a
 * compile error here, as it is a refusal in the generator.
 *
 * Row order matters for `mediaTypeForExtension`: extension collisions
 * (.xml, .yaml, .js, .ts, .webm) resolve to the first row declaring the
 * extension.
 */
export const MEDIA_TYPES = MEDIA_TYPE_ROWS satisfies Record<SupportedMediaType, MediaTypeCapabilities>;

// String-indexable view for lookups with runtime strings.
const REGISTRY: Readonly<Record<string, MediaTypeCapabilities>> = MEDIA_TYPES;

/**
 * Strip parameters ("; charset=...") and normalize case.
 * Replaces the inline `split(';')[0]` sites across the codebase.
 */
export function baseMediaType(format: string): string {
  return format.split(';')[0]!.trim().toLowerCase();
}

/**
 * Registry membership — the admission gate. Exact match: callers pass a
 * base type (see `baseMediaType`); strings carrying parameters are not
 * members.
 */
export function isSupportedMediaType(format: string): format is SupportedMediaType {
  return Object.hasOwn(MEDIA_TYPES, format);
}

/** Capabilities for a format (parameters tolerated), or undefined on registry miss. */
export function capabilitiesOf(format: string): MediaTypeCapabilities | undefined {
  return REGISTRY[baseMediaType(format)];
}

/**
 * The clone-format gate (MEDIA-TYPES.md Phase 5, moved here for
 * EXTRACT-ARCHIVIST's clone wire-shape change): a clone opens in the
 * compose editor, so authorable sources keep their base media type and
 * everything else falls back to text/plain. Lives beside the registry it
 * reads; the SDK applies it when deriving a clone upload's format and the
 * CloneTokenManager's tests pin it.
 */
export function cloneFormat(sourceMediaType: string | undefined): SupportedMediaType {
  const base = baseMediaType(sourceMediaType ?? 'text/plain');
  return isSupportedMediaType(base) && capabilitiesOf(base)?.authorable ? base : 'text/plain';
}

/**
 * Lenient extension lookup for naming foreign/imported content: '.dat' on
 * registry miss. Exporters use this — a vocabulary change must never
 * refuse to name restored data.
 */
export function extensionForMediaType(format: string): string {
  return capabilitiesOf(format)?.extension ?? '.dat';
}

const EXTENSION_TO_MEDIA_TYPE: ReadonlyMap<string, SupportedMediaType> = (() => {
  const map = new Map<string, SupportedMediaType>();
  for (const type of Object.keys(MEDIA_TYPES) as SupportedMediaType[]) {
    const ext = MEDIA_TYPES[type].extension;
    if (!map.has(ext)) map.set(ext, type);
  }
  return map;
})();

/**
 * Inverted registry: extension → media type, for the CLI and the upload
 * detection chain. Accepts 'md' or '.md', any case, and common alternate
 * spellings. Returns undefined for unknown extensions — detection chains
 * fall back to 'application/octet-stream' themselves.
 */
export function mediaTypeForExtension(ext: string): SupportedMediaType | undefined {
  const lower = ext.trim().toLowerCase();
  const dotted = lower.startsWith('.') ? lower : `.${lower}`;
  return EXTENSION_TO_MEDIA_TYPE.get(EXTENSION_ALIASES[dotted] ?? dotted);
}

/**
 * WHERE a format's text comes from. Registry rows answer directly; on a registry
 * miss, base types under text/* decode (RFC 2046 guarantees the text top-level
 * type is textual — imported unregistered text subtypes embed too), everything
 * else is 'none'.
 *
 * The three answers are different operations, not degrees of one: `decode` is a
 * pure charset-aware `Buffer → string` anyone holding bytes may run;
 * `pdf-text-layer` parses and, failing that, OCRs — expensive, not deterministic
 * across engine versions, and runnable only by the process that persists its
 * output. Calling both "extraction" is what this accessor was named for until
 * READ-VS-EXTRACT P3.
 */
export function textSourceOf(format: string): TextSource {
  const caps = capabilitiesOf(format);
  if (caps) return caps.textSource;
  return baseMediaType(format).startsWith('text/') ? 'decode' : 'none';
}

/**
 * Whether a text source yields positioned runs (`items`) — the geometry an
 * anchored-text artifact is made of. Only deriving does.
 *
 * Exhaustive over `TextSource` on purpose: a new strategy fails to compile
 * here until someone decides which side it is on, so the next media type cannot
 * default into the wrong answer. Private — `yieldsGeometryOf` is the surface.
 */
const GEOMETRY_BY_STRATEGY: Record<TextSource, boolean> = {
  'decode': false,
  'pdf-text-layer': true,
  'none': false,
};

/**
 * WHETHER a type's extracted text carries geometry — page-positioned runs
 * rather than a bare string. Answers "should an anchored-text artifact exist
 * for this resource?" (PERSIST-ANCHORS P0, the third drift class) and "does
 * this type anchor spatially or by character offset?".
 *
 * Derived from `textSource`, not stored: until READ-VS-EXTRACT P1 this was a
 * `yieldsGeometry` boolean declared on each `TextExtractor` in
 * `@semiont/content` — a property of the STRATEGY, declared per-implementation,
 * in a different package from the strategy vocabulary. Two facts that must
 * agree, gated by nothing, and consumers asking about a media type had to
 * resolve an implementation to get an answer.
 *
 * Lenient like `textSourceOf`, not strict like `isAnnotatable`. An
 * unregistered `text/*` type decodes, and decoding yields no geometry — so
 * `false` here is a real answer rather than a refusal. Nothing downstream is a
 * durable write against a coordinate model, which is what makes `isAnnotatable`
 * strict.
 */
export function yieldsGeometryOf(format: string): boolean {
  return GEOMETRY_BY_STRATEGY[textSourceOf(format)];
}

/**
 * Whether a text source's output is DERIVED — produced by the Smelter and
 * persisted as an anchored-text artifact — rather than read by decoding the
 * bytes. "Decoding is not deriving" (READ-VS-EXTRACT).
 *
 * Exhaustive over `TextSource` on purpose, like its geometry sibling: a new
 * strategy fails to compile here until someone declares its category.
 * Private — `derivesTextOf` is the surface.
 */
const DERIVED_TEXT_BY_STRATEGY: Record<TextSource, boolean> = {
  'decode': false,
  'pdf-text-layer': true,
  'none': false,
};

/**
 * WHETHER a type's text is the Smelter's derived artifact instead of its own
 * decoded bytes — the read-side dispatch a text READER needs
 * (bugs/gather-ships-raw-pdf-bytes P1): derived text is answered by the
 * anchored-text read; decoded text by `decodeRepresentation`, which refuses
 * everything else.
 *
 * Deliberately a DISTINCT question from `yieldsGeometryOf`, though the
 * answers coincide today: a future transcription strategy would derive text
 * with no geometry. The mechanism literal (`pdf-text-layer`) stays confined
 * to the extraction side, which genuinely dispatches per mechanism.
 */
export function derivesTextOf(format: string): boolean {
  return DERIVED_TEXT_BY_STRATEGY[textSourceOf(format)];
}

/**
 * WHETHER a type can carry annotations — `anchoring` remains the authority on
 * HOW. Derived rather than stored: a parallel `annotatable` row field would be
 * two facts that can disagree, with nothing to adjudicate
 * `{ annotatable: true, anchoring: 'none' }`.
 *
 * Strict on a registry miss, where `textSourceOf` above is lenient. The
 * asymmetry is deliberate. Reading the wrong bytes costs one bad vector, and
 * refusing to read costs a resource nobody can find, so the text source
 * guesses; an annotation is a durable write against a coordinate model the
 * system does not have for an unknown type, so it refuses.
 */
export function isAnnotatable(format: string): boolean {
  const caps = capabilitiesOf(format);
  return caps !== undefined && caps.anchoring !== 'none';
}

const REGISTRY_KEYS = Object.keys(MEDIA_TYPES) as SupportedMediaType[];

/** Types offered in the compose editor's format dropdown. */
export const AUTHORABLE_MEDIA_TYPES: readonly SupportedMediaType[] = REGISTRY_KEYS.filter(
  (type) => MEDIA_TYPES[type].authorable,
);

/** Registry rows whose text the Smelter can get at, by either route. Rows only —
 *  the text/* fallback in `textSourceOf` isn't enumerable. */
export const EMBEDDABLE_MEDIA_TYPES: readonly SupportedMediaType[] = REGISTRY_KEYS.filter(
  (type) => MEDIA_TYPES[type].textSource !== 'none',
);

/** Types the generation worker can produce as a yield artifact — the
 *  `outputMediaType` gate reads this, not a local table. */
export const GENERATABLE_MEDIA_TYPES: readonly SupportedMediaType[] = REGISTRY_KEYS.filter(
  (type) => MEDIA_TYPES[type].generatable,
);
