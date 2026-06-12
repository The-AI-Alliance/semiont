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
 * - `extractText` — how the Smelter gets embeddable text ('none' → skip
 *                   embedding, never mojibake)
 * - `authorable`  — offered in the compose editor's format dropdown
 * - `uploadable`  — big tent: true for every registry member
 *
 * Capabilities are orthogonal strategies, not a ladder: images render but
 * yield no text; PDFs yield text but aren't authorable. A "tier" is a
 * derived reading, not a stored fact.
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
export type TextExtraction = 'decode' | 'pdf-text-layer' | 'none';

export interface MediaTypeCapabilities {
  /** Canonical file extension, with leading dot. */
  extension: `.${string}`;
  /** UI display name. */
  label: string;
  render: RenderMode;
  anchoring: AnchoringModel;
  extractText: TextExtraction;
  authorable: boolean;
  uploadable: boolean;
}

/** Storage tier: catalogued — stored, named, uploadable — but not
 *  displayed or annotated. */
const storedBinary = (extension: `.${string}`, label: string): MediaTypeCapabilities => ({
  extension,
  label,
  render: 'none',
  anchoring: 'none',
  extractText: 'none',
  authorable: false,
  uploadable: true,
});

/** Storage tier, text-flavored: embedded (charset-aware decode), not rendered. */
const storedText = (extension: `.${string}`, label: string): MediaTypeCapabilities => ({
  ...storedBinary(extension, label),
  extractText: 'decode',
});

/**
 * The registry. `satisfies Record<SupportedMediaType, …>` is the
 * drift-lock: adding a type to the spec enum without a capabilities row
 * (or vice versa) is a compile error.
 *
 * Row order matters for `mediaTypeForExtension`: extension collisions
 * (.xml, .yaml, .js, .ts, .webm) resolve to the first row declaring the
 * extension.
 */
export const MEDIA_TYPES = {
  // Full-capability tier
  'text/markdown':    { extension: '.md',   label: 'Markdown',   render: 'text',  anchoring: 'text-selector', extractText: 'decode',         authorable: true,  uploadable: true },
  'text/plain':       { extension: '.txt',  label: 'Plain Text', render: 'text',  anchoring: 'text-selector', extractText: 'decode',         authorable: true,  uploadable: true },
  'text/html':        { extension: '.html', label: 'HTML',       render: 'text',  anchoring: 'text-selector', extractText: 'decode',         authorable: true,  uploadable: true },
  'application/json': { extension: '.json', label: 'JSON',       render: 'text',  anchoring: 'text-selector', extractText: 'decode',         authorable: false, uploadable: true },
  'image/png':        { extension: '.png',  label: 'PNG image',  render: 'image', anchoring: 'spatial',       extractText: 'none',           authorable: false, uploadable: true },
  'image/jpeg':       { extension: '.jpg',  label: 'JPEG image', render: 'image', anchoring: 'spatial',       extractText: 'none',           authorable: false, uploadable: true },
  'application/pdf':  { extension: '.pdf',  label: 'PDF',        render: 'pdf',   anchoring: 'spatial',       extractText: 'pdf-text-layer', authorable: false, uploadable: true },

  // Storage tier — the big tent. Every row is a deliberate admission,
  // promotable by editing its row. Text-flavored rows embed (decode).

  // Text
  'text/css': storedText('.css', 'CSS'),
  'text/csv': storedText('.csv', 'CSV'),
  'text/xml': storedText('.xml', 'XML'),

  // Structured-text application formats
  'application/xml': storedText('.xml', 'XML'),
  'application/yaml': storedText('.yaml', 'YAML'),
  'application/x-yaml': storedText('.yaml', 'YAML'),

  // Programming languages
  'text/javascript': storedText('.js', 'JavaScript'),
  'application/javascript': storedText('.js', 'JavaScript'),
  'text/x-typescript': storedText('.ts', 'TypeScript'),
  'application/typescript': storedText('.ts', 'TypeScript'),
  'text/x-python': storedText('.py', 'Python source'),
  'text/x-java': storedText('.java', 'Java source'),
  'text/x-c': storedText('.c', 'C source'),
  'text/x-c++': storedText('.cpp', 'C++ source'),
  'text/x-csharp': storedText('.cs', 'C# source'),
  'text/x-go': storedText('.go', 'Go source'),
  'text/x-rust': storedText('.rs', 'Rust source'),
  'text/x-ruby': storedText('.rb', 'Ruby source'),
  'text/x-php': storedText('.php', 'PHP source'),
  'text/x-swift': storedText('.swift', 'Swift source'),
  'text/x-kotlin': storedText('.kt', 'Kotlin source'),
  'text/x-shell': storedText('.sh', 'Shell script'),

  // Documents
  'application/msword': storedBinary('.doc', 'Word document (legacy)'),
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': storedBinary('.docx', 'Word document'),
  'application/vnd.ms-excel': storedBinary('.xls', 'Excel spreadsheet (legacy)'),
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': storedBinary('.xlsx', 'Excel spreadsheet'),
  'application/vnd.ms-powerpoint': storedBinary('.ppt', 'PowerPoint presentation (legacy)'),
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': storedBinary('.pptx', 'PowerPoint presentation'),

  // Archives
  'application/zip': storedBinary('.zip', 'ZIP archive'),
  'application/gzip': storedBinary('.gz', 'Gzip archive'),
  'application/x-tar': storedBinary('.tar', 'TAR archive'),
  'application/x-7z-compressed': storedBinary('.7z', '7z archive'),

  // Binaries
  'application/octet-stream': storedBinary('.bin', 'Binary'),
  'application/wasm': storedBinary('.wasm', 'WebAssembly module'),

  // Images beyond the rendered pair
  'image/gif': storedBinary('.gif', 'GIF image'),
  'image/webp': storedBinary('.webp', 'WebP image'),
  'image/svg+xml': storedBinary('.svg', 'SVG image'),
  'image/bmp': storedBinary('.bmp', 'BMP image'),
  'image/tiff': storedBinary('.tiff', 'TIFF image'),
  'image/x-icon': storedBinary('.ico', 'Icon'),

  // Video (before audio so .webm resolves to video)
  'video/mp4': storedBinary('.mp4', 'MP4 video'),
  'video/mpeg': storedBinary('.mpeg', 'MPEG video'),
  'video/webm': storedBinary('.webm', 'WebM video'),
  'video/ogg': storedBinary('.ogv', 'Ogg video'),
  'video/quicktime': storedBinary('.mov', 'QuickTime video'),
  'video/x-msvideo': storedBinary('.avi', 'AVI video'),

  // Audio
  'audio/mpeg': storedBinary('.mp3', 'MP3 audio'),
  'audio/wav': storedBinary('.wav', 'WAV audio'),
  'audio/ogg': storedBinary('.ogg', 'Ogg audio'),
  'audio/webm': storedBinary('.webm', 'WebM audio'),
  'audio/aac': storedBinary('.aac', 'AAC audio'),
  'audio/flac': storedBinary('.flac', 'FLAC audio'),

  // Fonts
  'font/woff': storedBinary('.woff', 'WOFF font'),
  'font/woff2': storedBinary('.woff2', 'WOFF2 font'),
  'font/ttf': storedBinary('.ttf', 'TrueType font'),
  'font/otf': storedBinary('.otf', 'OpenType font'),
} satisfies Record<SupportedMediaType, MediaTypeCapabilities>;

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

/** Alternate spellings accepted by `mediaTypeForExtension`, mapped to
 *  canonical registry extensions. */
const EXTENSION_ALIASES: Readonly<Record<string, string>> = {
  '.markdown': '.md',
  '.htm': '.html',
  '.jpeg': '.jpg',
  '.yml': '.yaml',
};

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
 * The Smelter's gate: how to get embeddable text from a format. Registry
 * rows answer directly; on a registry miss, base types under text/* decode
 * (RFC 2046 guarantees the text top-level type is textual — imported
 * unregistered text subtypes embed too), everything else is 'none'.
 */
export function textExtractionOf(format: string): TextExtraction {
  const caps = capabilitiesOf(format);
  if (caps) return caps.extractText;
  return baseMediaType(format).startsWith('text/') ? 'decode' : 'none';
}

const REGISTRY_KEYS = Object.keys(MEDIA_TYPES) as SupportedMediaType[];

/** Types offered in the compose editor's format dropdown. */
export const AUTHORABLE_MEDIA_TYPES: readonly SupportedMediaType[] = REGISTRY_KEYS.filter(
  (type) => MEDIA_TYPES[type].authorable,
);

/** Registry rows whose text the Smelter can extract. Rows only — the
 *  text/* fallback in `textExtractionOf` isn't enumerable. */
export const EMBEDDABLE_MEDIA_TYPES: readonly SupportedMediaType[] = REGISTRY_KEYS.filter(
  (type) => MEDIA_TYPES[type].extractText !== 'none',
);
