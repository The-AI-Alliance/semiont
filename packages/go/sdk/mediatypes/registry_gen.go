// Code generated from specs/src/media-types/registry.json — DO NOT EDIT.
//
// Regenerate: node scripts/spec/generate-media-types-go.mjs
// The TypeScript side (packages/typescript/core/src/generated/media-types.ts) and the
// Rust side (semiont::media_types) generate from the same registry.

package mediatypes

// TextSource is where a type's text comes from: decoded from its own bytes,
// derived by reading them, or nowhere.
type TextSource string

const (
	TextSourceDecode       TextSource = "decode"
	TextSourcePdfTextLayer TextSource = "pdf-text-layer"
	TextSourceNone         TextSource = "none"
)

// Row is one media type a knowledge base admits, with the extension a stored
// name takes for it, where its text comes from, and whether it is offered
// where a person writes a resource.
type Row struct {
	MediaType  string
	Extension  string
	TextSource TextSource
	Authorable bool
}

// Rows is the registry, in its own order: 63 media types. The order is
// read: two types that share an extension resolve, from the extension, to the
// first row that states it.
var Rows = []Row{
	{MediaType: "text/markdown", Extension: ".md", TextSource: TextSourceDecode, Authorable: true},
	{MediaType: "text/plain", Extension: ".txt", TextSource: TextSourceDecode, Authorable: true},
	{MediaType: "text/html", Extension: ".html", TextSource: TextSourceDecode, Authorable: true},
	{MediaType: "application/json", Extension: ".json", TextSource: TextSourceDecode, Authorable: false},
	{MediaType: "image/png", Extension: ".png", TextSource: TextSourceNone, Authorable: false},
	{MediaType: "image/jpeg", Extension: ".jpg", TextSource: TextSourceNone, Authorable: false},
	{MediaType: "application/pdf", Extension: ".pdf", TextSource: TextSourcePdfTextLayer, Authorable: false},
	{MediaType: "text/css", Extension: ".css", TextSource: TextSourceDecode, Authorable: false},
	{MediaType: "text/csv", Extension: ".csv", TextSource: TextSourceDecode, Authorable: false},
	{MediaType: "text/xml", Extension: ".xml", TextSource: TextSourceDecode, Authorable: false},
	{MediaType: "application/xml", Extension: ".xml", TextSource: TextSourceDecode, Authorable: false},
	{MediaType: "application/yaml", Extension: ".yaml", TextSource: TextSourceDecode, Authorable: false},
	{MediaType: "application/x-yaml", Extension: ".yaml", TextSource: TextSourceDecode, Authorable: false},
	{MediaType: "text/javascript", Extension: ".js", TextSource: TextSourceDecode, Authorable: false},
	{MediaType: "application/javascript", Extension: ".js", TextSource: TextSourceDecode, Authorable: false},
	{MediaType: "text/x-typescript", Extension: ".ts", TextSource: TextSourceDecode, Authorable: false},
	{MediaType: "application/typescript", Extension: ".ts", TextSource: TextSourceDecode, Authorable: false},
	{MediaType: "text/x-python", Extension: ".py", TextSource: TextSourceDecode, Authorable: false},
	{MediaType: "text/x-java", Extension: ".java", TextSource: TextSourceDecode, Authorable: false},
	{MediaType: "text/x-c", Extension: ".c", TextSource: TextSourceDecode, Authorable: false},
	{MediaType: "text/x-c++", Extension: ".cpp", TextSource: TextSourceDecode, Authorable: false},
	{MediaType: "text/x-csharp", Extension: ".cs", TextSource: TextSourceDecode, Authorable: false},
	{MediaType: "text/x-go", Extension: ".go", TextSource: TextSourceDecode, Authorable: false},
	{MediaType: "text/x-rust", Extension: ".rs", TextSource: TextSourceDecode, Authorable: false},
	{MediaType: "text/x-ruby", Extension: ".rb", TextSource: TextSourceDecode, Authorable: false},
	{MediaType: "text/x-php", Extension: ".php", TextSource: TextSourceDecode, Authorable: false},
	{MediaType: "text/x-swift", Extension: ".swift", TextSource: TextSourceDecode, Authorable: false},
	{MediaType: "text/x-kotlin", Extension: ".kt", TextSource: TextSourceDecode, Authorable: false},
	{MediaType: "text/x-shell", Extension: ".sh", TextSource: TextSourceDecode, Authorable: false},
	{MediaType: "application/msword", Extension: ".doc", TextSource: TextSourceNone, Authorable: false},
	{MediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", Extension: ".docx", TextSource: TextSourceNone, Authorable: false},
	{MediaType: "application/vnd.ms-excel", Extension: ".xls", TextSource: TextSourceNone, Authorable: false},
	{MediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", Extension: ".xlsx", TextSource: TextSourceNone, Authorable: false},
	{MediaType: "application/vnd.ms-powerpoint", Extension: ".ppt", TextSource: TextSourceNone, Authorable: false},
	{MediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", Extension: ".pptx", TextSource: TextSourceNone, Authorable: false},
	{MediaType: "application/zip", Extension: ".zip", TextSource: TextSourceNone, Authorable: false},
	{MediaType: "application/gzip", Extension: ".gz", TextSource: TextSourceNone, Authorable: false},
	{MediaType: "application/x-tar", Extension: ".tar", TextSource: TextSourceNone, Authorable: false},
	{MediaType: "application/x-7z-compressed", Extension: ".7z", TextSource: TextSourceNone, Authorable: false},
	{MediaType: "application/octet-stream", Extension: ".bin", TextSource: TextSourceNone, Authorable: false},
	{MediaType: "application/wasm", Extension: ".wasm", TextSource: TextSourceNone, Authorable: false},
	{MediaType: "image/gif", Extension: ".gif", TextSource: TextSourceNone, Authorable: false},
	{MediaType: "image/webp", Extension: ".webp", TextSource: TextSourceNone, Authorable: false},
	{MediaType: "image/svg+xml", Extension: ".svg", TextSource: TextSourceNone, Authorable: false},
	{MediaType: "image/bmp", Extension: ".bmp", TextSource: TextSourceNone, Authorable: false},
	{MediaType: "image/tiff", Extension: ".tiff", TextSource: TextSourceNone, Authorable: false},
	{MediaType: "image/x-icon", Extension: ".ico", TextSource: TextSourceNone, Authorable: false},
	{MediaType: "video/mp4", Extension: ".mp4", TextSource: TextSourceNone, Authorable: false},
	{MediaType: "video/mpeg", Extension: ".mpeg", TextSource: TextSourceNone, Authorable: false},
	{MediaType: "video/webm", Extension: ".webm", TextSource: TextSourceNone, Authorable: false},
	{MediaType: "video/ogg", Extension: ".ogv", TextSource: TextSourceNone, Authorable: false},
	{MediaType: "video/quicktime", Extension: ".mov", TextSource: TextSourceNone, Authorable: false},
	{MediaType: "video/x-msvideo", Extension: ".avi", TextSource: TextSourceNone, Authorable: false},
	{MediaType: "audio/mpeg", Extension: ".mp3", TextSource: TextSourceNone, Authorable: false},
	{MediaType: "audio/wav", Extension: ".wav", TextSource: TextSourceNone, Authorable: false},
	{MediaType: "audio/ogg", Extension: ".ogg", TextSource: TextSourceNone, Authorable: false},
	{MediaType: "audio/webm", Extension: ".webm", TextSource: TextSourceNone, Authorable: false},
	{MediaType: "audio/aac", Extension: ".aac", TextSource: TextSourceNone, Authorable: false},
	{MediaType: "audio/flac", Extension: ".flac", TextSource: TextSourceNone, Authorable: false},
	{MediaType: "font/woff", Extension: ".woff", TextSource: TextSourceNone, Authorable: false},
	{MediaType: "font/woff2", Extension: ".woff2", TextSource: TextSourceNone, Authorable: false},
	{MediaType: "font/ttf", Extension: ".ttf", TextSource: TextSourceNone, Authorable: false},
	{MediaType: "font/otf", Extension: ".otf", TextSource: TextSourceNone, Authorable: false},
}

// ExtensionAliases are other spellings of an extension, each with the one a
// row states.
var ExtensionAliases = map[string]string{
	".markdown": ".md",
	".htm":      ".html",
	".jpeg":     ".jpg",
	".yml":      ".yaml",
}
