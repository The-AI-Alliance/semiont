# Dataset Configurations

This directory contains configuration files for demo datasets. Each dataset has its own subdirectory with a `config.ts` file.

## Directory Structure

```
config/
├── types.ts                      # Shared types
├── README.md                     # This file
├── citizens_united/              # Citizens United dataset
│   ├── config.ts                 # Dataset configuration
│   └── .state.json               # State file (gitignored)
├── hiking/                       # Hiking notes dataset
│   ├── config.ts
│   └── .state.json               # (gitignored)
├── arxiv/                        # ArXiv paper dataset
│   ├── config.ts
│   └── .state.json               # (gitignored)
└── prometheus_bound/             # Prometheus Bound dataset
    ├── config.ts
    └── .state.json               # (gitignored)
```

## Adding a New Dataset

To add a new dataset to the demo system:

1. **Create a new directory** in this directory named after your dataset (e.g., `my_dataset/`)
2. **Create a `config.ts` file** in that directory
3. **Import required types and utilities**:

   ```typescript
   import type { DatasetConfig } from '../types.js';
   import { printInfo, printSuccess } from '../../src/display.js';
   // Import any other utilities you need
   ```

4. **Define and export your configuration**:
   ```typescript
   export const config: DatasetConfig = {
     name: 'my_dataset',              // Internal identifier (use snake_case)
     displayName: 'My Dataset',       // Human-readable name
     emoji: '📚',                      // Emoji for display
     shouldChunk: true,                // Whether to split into chunks
     chunkSize: 5000,                  // Characters per chunk (if chunking)
     useSmartChunking: false,          // Use paragraph boundaries vs fixed size
     entityTypes: ['type1', 'type2'],  // Metadata tags
     createTableOfContents: true,      // Create TOC with linked references
     tocTitle: 'My Dataset - TOC',     // Title for the TOC
     detectCitations: false,           // Enable citation detection
     cacheFile: '/tmp/my_dataset.txt',  // Where to cache downloaded content

     // Optional: Download function (omit if data is already local)
     downloadContent: async () => {
       // Download and save to cacheFile
       printInfo('Downloading...');
       const data = await fetch('https://example.com/data');
       writeFileSync('/tmp/my_dataset.txt', await data.text());
       printSuccess('Downloaded!');
     },

     // Required: Load function that returns the formatted text
     loadText: async () => {
       printInfo('Loading...');
       const text = readFileSync('/tmp/my_dataset.txt', 'utf-8');
       printSuccess('Loaded!');
       return text;
     },
   };
   ```

5. **Add npm scripts** in `package.json` (optional, for convenience):

   ```json
   "demo:my-dataset:download": "dotenv -e .env -- tsx demo.ts my_dataset download",
   "demo:my-dataset:load": "dotenv -e .env -- tsx demo.ts my_dataset load",
   "demo:my-dataset:annotate": "dotenv -e .env -- tsx demo.ts my_dataset annotate"
   ```

**That's it!** The dataset will be automatically discovered and loaded by `demo.ts` at startup. No need to modify `demo.ts` itself.

The discovery process scans all subdirectories in `config/` and looks for a `config.ts` file in each one.

**Note:** State files are automatically created as `.state.json` in each dataset's config directory. These files store the state between load and annotate phases and are gitignored.

## Configuration Options

### Required Fields
- `name`: Internal identifier (snake_case, used in commands)
- `displayName`: User-facing name
- `emoji`: Display emoji
- `shouldChunk`: Whether to split document into chunks
- `entityTypes`: Array of metadata tags
- `createTableOfContents`: Whether to create TOC
- `detectCitations`: Whether to run citation detection
- `cacheFile`: Path to cached content
- `loadText`: Function that returns formatted text

### Optional Fields
- `chunkSize`: Characters per chunk (required if `shouldChunk: true`)
- `useSmartChunking`: Use paragraph-aware chunking (default: false)
- `tocTitle`: Title for table of contents (required if `createTableOfContents: true`)
- `downloadContent`: Function to download and cache content
- `extractionConfig`: Patterns for extracting sections from larger texts
  - `startPattern`: Regex to find start of content
  - `endMarker`: String marking end of content

## Chunking Strategies

### Fixed-Size Chunking
```typescript
shouldChunk: true,
chunkSize: 5000,
useSmartChunking: false,  // or omit
```
Splits text into equal-sized chunks (useful for legal documents).

### Smart Chunking
```typescript
shouldChunk: true,
chunkSize: 4000,
useSmartChunking: true,
```
Splits at paragraph boundaries near target size (useful for prose).

### No Chunking
```typescript
shouldChunk: false,
```
Uploads as a single document.

## Examples

See existing configurations:
- [`citizens_united/config.ts`](./citizens_united/config.ts) - Legal document with citation detection
- [`hiking/config.ts`](./hiking/config.ts) - Simple local file, no processing
- [`arxiv/config.ts`](./arxiv/config.ts) - API integration with metadata
- [`prometheus_bound/config.ts`](./prometheus_bound/config.ts) - Text extraction with smart chunking
