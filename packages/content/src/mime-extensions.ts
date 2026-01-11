/**
 * MIME Type to File Extension Mapping
 *
 * Maps common MIME types to their standard file extensions.
 * Used by RepresentationStore to save files with proper extensions.
 */

/**
 * Comprehensive MIME type to extension mapping
 */
const MIME_TO_EXTENSION: Record<string, string> = {
  // Text formats
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/html': '.html',
  'text/css': '.css',
  'text/csv': '.csv',
  'text/xml': '.xml',

  // Application formats - structured data
  'application/json': '.json',
  'application/xml': '.xml',
  'application/yaml': '.yaml',
  'application/x-yaml': '.yaml',

  // Application formats - documents
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',

  // Application formats - archives
  'application/zip': '.zip',
  'application/gzip': '.gz',
  'application/x-tar': '.tar',
  'application/x-7z-compressed': '.7z',

  // Application formats - executables/binaries
  'application/octet-stream': '.bin',
  'application/wasm': '.wasm',

  // Image formats
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  'image/x-icon': '.ico',

  // Audio formats
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/webm': '.webm',
  'audio/aac': '.aac',
  'audio/flac': '.flac',

  // Video formats
  'video/mp4': '.mp4',
  'video/mpeg': '.mpeg',
  'video/webm': '.webm',
  'video/ogg': '.ogv',
  'video/quicktime': '.mov',
  'video/x-msvideo': '.avi',

  // Programming languages
  'text/javascript': '.js',
  'application/javascript': '.js',
  'text/x-typescript': '.ts',
  'application/typescript': '.ts',
  'text/x-python': '.py',
  'text/x-java': '.java',
  'text/x-c': '.c',
  'text/x-c++': '.cpp',
  'text/x-csharp': '.cs',
  'text/x-go': '.go',
  'text/x-rust': '.rs',
  'text/x-ruby': '.rb',
  'text/x-php': '.php',
  'text/x-swift': '.swift',
  'text/x-kotlin': '.kt',
  'text/x-shell': '.sh',

  // Font formats
  'font/woff': '.woff',
  'font/woff2': '.woff2',
  'font/ttf': '.ttf',
  'font/otf': '.otf',
};

/**
 * Get file extension for a MIME type
 *
 * @param mediaType - MIME type (e.g., "text/markdown")
 * @returns File extension with leading dot (e.g., ".md") or ".dat" if unknown
 *
 * @example
 * getExtensionForMimeType('text/markdown') // => '.md'
 * getExtensionForMimeType('image/png')     // => '.png'
 * getExtensionForMimeType('unknown/type')  // => '.dat'
 */
export function getExtensionForMimeType(mediaType: string): string {
  // Normalize MIME type (lowercase, remove parameters)
  const normalized = mediaType.toLowerCase().split(';')[0]!.trim();

  // Look up in mapping
  const extension = MIME_TO_EXTENSION[normalized];

  // Return mapped extension or fallback to .dat
  return extension || '.dat';
}

/**
 * Check if a MIME type has a known extension mapping
 *
 * @param mediaType - MIME type to check
 * @returns true if extension is known, false if would fallback to .dat
 */
export function hasKnownExtension(mediaType: string): boolean {
  const normalized = mediaType.toLowerCase().split(';')[0]!.trim();
  return normalized in MIME_TO_EXTENSION;
}
