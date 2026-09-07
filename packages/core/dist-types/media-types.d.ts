/**
 * Media-type registry for Semiont
 *
 * One supported-types list, capability-tiered, keyed by the spec's
 * SupportedMediaType enum. Admission (registry membership) is the
 * create/yield gate: every member is storable, nameable, and uploadable.
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
export type SupportedMediaType = components['schemas']['SupportedMediaType'];
export type RenderMode = 'text' | 'image' | 'pdf' | 'none';
export type AnchoringModel = 'text-selector' | 'spatial' | 'none';
export type TextSource = 'decode' | 'pdf-text-layer' | 'none';
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
 * The registry. `satisfies Record<SupportedMediaType, …>` is the
 * drift-lock: adding a type to the spec enum without a capabilities row
 * (or vice versa) is a compile error.
 *
 * Row order matters for `mediaTypeForExtension`: extension collisions
 * (.xml, .yaml, .js, .ts, .webm) resolve to the first row declaring the
 * extension.
 */
export declare const MEDIA_TYPES: {
    'text/markdown': {
        extension: ".md";
        label: string;
        render: "text";
        anchoring: "text-selector";
        textSource: "decode";
        authorable: true;
        uploadable: true;
        generatable: true;
    };
    'text/plain': {
        extension: ".txt";
        label: string;
        render: "text";
        anchoring: "text-selector";
        textSource: "decode";
        authorable: true;
        uploadable: true;
        generatable: true;
    };
    'text/html': {
        extension: ".html";
        label: string;
        render: "text";
        anchoring: "text-selector";
        textSource: "decode";
        authorable: true;
        uploadable: true;
        generatable: false;
    };
    'application/json': {
        extension: ".json";
        label: string;
        render: "text";
        anchoring: "text-selector";
        textSource: "decode";
        authorable: false;
        uploadable: true;
        generatable: false;
    };
    'image/png': {
        extension: ".png";
        label: string;
        render: "image";
        anchoring: "spatial";
        textSource: "none";
        authorable: false;
        uploadable: true;
        generatable: false;
    };
    'image/jpeg': {
        extension: ".jpg";
        label: string;
        render: "image";
        anchoring: "spatial";
        textSource: "none";
        authorable: false;
        uploadable: true;
        generatable: false;
    };
    'application/pdf': {
        extension: ".pdf";
        label: string;
        render: "pdf";
        anchoring: "spatial";
        textSource: "pdf-text-layer";
        authorable: false;
        uploadable: true;
        generatable: true;
    };
    'text/css': MediaTypeCapabilities;
    'text/csv': MediaTypeCapabilities;
    'text/xml': MediaTypeCapabilities;
    'application/xml': MediaTypeCapabilities;
    'application/yaml': MediaTypeCapabilities;
    'application/x-yaml': MediaTypeCapabilities;
    'text/javascript': MediaTypeCapabilities;
    'application/javascript': MediaTypeCapabilities;
    'text/x-typescript': MediaTypeCapabilities;
    'application/typescript': MediaTypeCapabilities;
    'text/x-python': MediaTypeCapabilities;
    'text/x-java': MediaTypeCapabilities;
    'text/x-c': MediaTypeCapabilities;
    'text/x-c++': MediaTypeCapabilities;
    'text/x-csharp': MediaTypeCapabilities;
    'text/x-go': MediaTypeCapabilities;
    'text/x-rust': MediaTypeCapabilities;
    'text/x-ruby': MediaTypeCapabilities;
    'text/x-php': MediaTypeCapabilities;
    'text/x-swift': MediaTypeCapabilities;
    'text/x-kotlin': MediaTypeCapabilities;
    'text/x-shell': MediaTypeCapabilities;
    'application/msword': MediaTypeCapabilities;
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': MediaTypeCapabilities;
    'application/vnd.ms-excel': MediaTypeCapabilities;
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': MediaTypeCapabilities;
    'application/vnd.ms-powerpoint': MediaTypeCapabilities;
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': MediaTypeCapabilities;
    'application/zip': MediaTypeCapabilities;
    'application/gzip': MediaTypeCapabilities;
    'application/x-tar': MediaTypeCapabilities;
    'application/x-7z-compressed': MediaTypeCapabilities;
    'application/octet-stream': MediaTypeCapabilities;
    'application/wasm': MediaTypeCapabilities;
    'image/gif': MediaTypeCapabilities;
    'image/webp': MediaTypeCapabilities;
    'image/svg+xml': MediaTypeCapabilities;
    'image/bmp': MediaTypeCapabilities;
    'image/tiff': MediaTypeCapabilities;
    'image/x-icon': MediaTypeCapabilities;
    'video/mp4': MediaTypeCapabilities;
    'video/mpeg': MediaTypeCapabilities;
    'video/webm': MediaTypeCapabilities;
    'video/ogg': MediaTypeCapabilities;
    'video/quicktime': MediaTypeCapabilities;
    'video/x-msvideo': MediaTypeCapabilities;
    'audio/mpeg': MediaTypeCapabilities;
    'audio/wav': MediaTypeCapabilities;
    'audio/ogg': MediaTypeCapabilities;
    'audio/webm': MediaTypeCapabilities;
    'audio/aac': MediaTypeCapabilities;
    'audio/flac': MediaTypeCapabilities;
    'font/woff': MediaTypeCapabilities;
    'font/woff2': MediaTypeCapabilities;
    'font/ttf': MediaTypeCapabilities;
    'font/otf': MediaTypeCapabilities;
};
/**
 * Strip parameters ("; charset=...") and normalize case.
 * Replaces the inline `split(';')[0]` sites across the codebase.
 */
export declare function baseMediaType(format: string): string;
/**
 * Registry membership — the admission gate. Exact match: callers pass a
 * base type (see `baseMediaType`); strings carrying parameters are not
 * members.
 */
export declare function isSupportedMediaType(format: string): format is SupportedMediaType;
/** Capabilities for a format (parameters tolerated), or undefined on registry miss. */
export declare function capabilitiesOf(format: string): MediaTypeCapabilities | undefined;
/**
 * The clone-format gate (MEDIA-TYPES.md Phase 5, moved here for
 * EXTRACT-ARCHIVIST's clone wire-shape change): a clone opens in the
 * compose editor, so authorable sources keep their base media type and
 * everything else falls back to text/plain. Lives beside the registry it
 * reads; the SDK applies it when deriving a clone upload's format and the
 * CloneTokenManager's tests pin it.
 */
export declare function cloneFormat(sourceMediaType: string | undefined): SupportedMediaType;
/**
 * Lenient extension lookup for naming foreign/imported content: '.dat' on
 * registry miss. Exporters use this — a vocabulary change must never
 * refuse to name restored data.
 */
export declare function extensionForMediaType(format: string): string;
/**
 * Inverted registry: extension → media type, for the CLI and the upload
 * detection chain. Accepts 'md' or '.md', any case, and common alternate
 * spellings. Returns undefined for unknown extensions — detection chains
 * fall back to 'application/octet-stream' themselves.
 */
export declare function mediaTypeForExtension(ext: string): SupportedMediaType | undefined;
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
export declare function textSourceOf(format: string): TextSource;
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
export declare function yieldsGeometryOf(format: string): boolean;
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
export declare function isAnnotatable(format: string): boolean;
/** Types offered in the compose editor's format dropdown. */
export declare const AUTHORABLE_MEDIA_TYPES: readonly SupportedMediaType[];
/** Registry rows whose text the Smelter can get at, by either route. Rows only —
 *  the text/* fallback in `textSourceOf` isn't enumerable. */
export declare const EMBEDDABLE_MEDIA_TYPES: readonly SupportedMediaType[];
/** Types the generation worker can produce as a yield artifact — the
 *  `outputMediaType` gate reads this, not a local table. */
export declare const GENERATABLE_MEDIA_TYPES: readonly SupportedMediaType[];
