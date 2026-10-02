// Code generated from specs/src/media-types/registry.json — DO NOT EDIT.
//
// Regenerate: node scripts/spec/generate-media-types-go.mjs
// The TypeScript side (packages/core/src/generated/media-types.ts) and the
// Rust side (semiont::media_types) generate from the same registry.

package mediatypes

// Row is one media type a knowledge base admits, with the extension a stored
// name takes for it.
type Row struct {
	MediaType string
	Extension string
}

// Rows is the registry, in its own order: 63 media types. The order is
// read: two types that share an extension resolve, from the extension, to the
// first row that states it.
var Rows = []Row{
	{MediaType: "text/markdown", Extension: ".md"},
	{MediaType: "text/plain", Extension: ".txt"},
	{MediaType: "text/html", Extension: ".html"},
	{MediaType: "application/json", Extension: ".json"},
	{MediaType: "image/png", Extension: ".png"},
	{MediaType: "image/jpeg", Extension: ".jpg"},
	{MediaType: "application/pdf", Extension: ".pdf"},
	{MediaType: "text/css", Extension: ".css"},
	{MediaType: "text/csv", Extension: ".csv"},
	{MediaType: "text/xml", Extension: ".xml"},
	{MediaType: "application/xml", Extension: ".xml"},
	{MediaType: "application/yaml", Extension: ".yaml"},
	{MediaType: "application/x-yaml", Extension: ".yaml"},
	{MediaType: "text/javascript", Extension: ".js"},
	{MediaType: "application/javascript", Extension: ".js"},
	{MediaType: "text/x-typescript", Extension: ".ts"},
	{MediaType: "application/typescript", Extension: ".ts"},
	{MediaType: "text/x-python", Extension: ".py"},
	{MediaType: "text/x-java", Extension: ".java"},
	{MediaType: "text/x-c", Extension: ".c"},
	{MediaType: "text/x-c++", Extension: ".cpp"},
	{MediaType: "text/x-csharp", Extension: ".cs"},
	{MediaType: "text/x-go", Extension: ".go"},
	{MediaType: "text/x-rust", Extension: ".rs"},
	{MediaType: "text/x-ruby", Extension: ".rb"},
	{MediaType: "text/x-php", Extension: ".php"},
	{MediaType: "text/x-swift", Extension: ".swift"},
	{MediaType: "text/x-kotlin", Extension: ".kt"},
	{MediaType: "text/x-shell", Extension: ".sh"},
	{MediaType: "application/msword", Extension: ".doc"},
	{MediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", Extension: ".docx"},
	{MediaType: "application/vnd.ms-excel", Extension: ".xls"},
	{MediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", Extension: ".xlsx"},
	{MediaType: "application/vnd.ms-powerpoint", Extension: ".ppt"},
	{MediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", Extension: ".pptx"},
	{MediaType: "application/zip", Extension: ".zip"},
	{MediaType: "application/gzip", Extension: ".gz"},
	{MediaType: "application/x-tar", Extension: ".tar"},
	{MediaType: "application/x-7z-compressed", Extension: ".7z"},
	{MediaType: "application/octet-stream", Extension: ".bin"},
	{MediaType: "application/wasm", Extension: ".wasm"},
	{MediaType: "image/gif", Extension: ".gif"},
	{MediaType: "image/webp", Extension: ".webp"},
	{MediaType: "image/svg+xml", Extension: ".svg"},
	{MediaType: "image/bmp", Extension: ".bmp"},
	{MediaType: "image/tiff", Extension: ".tiff"},
	{MediaType: "image/x-icon", Extension: ".ico"},
	{MediaType: "video/mp4", Extension: ".mp4"},
	{MediaType: "video/mpeg", Extension: ".mpeg"},
	{MediaType: "video/webm", Extension: ".webm"},
	{MediaType: "video/ogg", Extension: ".ogv"},
	{MediaType: "video/quicktime", Extension: ".mov"},
	{MediaType: "video/x-msvideo", Extension: ".avi"},
	{MediaType: "audio/mpeg", Extension: ".mp3"},
	{MediaType: "audio/wav", Extension: ".wav"},
	{MediaType: "audio/ogg", Extension: ".ogg"},
	{MediaType: "audio/webm", Extension: ".webm"},
	{MediaType: "audio/aac", Extension: ".aac"},
	{MediaType: "audio/flac", Extension: ".flac"},
	{MediaType: "font/woff", Extension: ".woff"},
	{MediaType: "font/woff2", Extension: ".woff2"},
	{MediaType: "font/ttf", Extension: ".ttf"},
	{MediaType: "font/otf", Extension: ".otf"},
}

// ExtensionAliases are other spellings of an extension, each with the one a
// row states.
var ExtensionAliases = map[string]string{
	".markdown": ".md",
	".htm":      ".html",
	".jpeg":     ".jpg",
	".yml":      ".yaml",
}
