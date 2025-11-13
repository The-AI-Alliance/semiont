# Dataset Configurations

This directory contains configuration files for demo datasets. Each dataset is defined in its own TypeScript file.

## Adding a New Dataset

To add a new dataset to the demo system:

1. **Create a new configuration file** in this directory (e.g., `my-dataset.ts`)
2. **Import required types and utilities**:
   ```typescript
   import type { DatasetConfig } from './types.js';
   import { printInfo, printSuccess } from '../src/display.js';
   // Import any other utilities you need
   ```

3. **Define and export your configuration**:
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
     stateFile: '.demo-my-dataset-state.json',  // State persistence file
     detectCitations: false,           // Enable citation detection
     cacheFile: 'data/tmp/my_dataset.txt',  // Where to cache downloaded content

     // Optional: Download function (omit if data is already local)
     downloadContent: async () => {
       // Download and save to cacheFile
       printInfo('Downloading...');
       const data = await fetch('https://example.com/data');
       writeFileSync('data/tmp/my_dataset.txt', await data.text());
       printSuccess('Downloaded!');
     },

     // Required: Load function that returns the formatted text
     loadText: async () => {
       printInfo('Loading...');
       const text = readFileSync('data/tmp/my_dataset.txt', 'utf-8');
       printSuccess('Loaded!');
       return text;
     },
   };
   ```

4. **Add npm scripts** in `package.json` (optional, for convenience):
   ```json
   "demo:my-dataset:download": "dotenv -e .env -- tsx demo.ts my_dataset download",
   "demo:my-dataset:load": "dotenv -e .env -- tsx demo.ts my_dataset load",
   "demo:my-dataset:annotate": "dotenv -e .env -- tsx demo.ts my_dataset annotate"
   ```

**That's it!** The dataset will be automatically discovered and loaded by `demo.ts` at startup. No need to modify `demo.ts` itself.

## Configuration Options

### Required Fields
- `name`: Internal identifier (snake_case, used in commands)
- `displayName`: User-facing name
- `emoji`: Display emoji
- `shouldChunk`: Whether to split document into chunks
- `entityTypes`: Array of metadata tags
- `createTableOfContents`: Whether to create TOC
- `stateFile`: Path to state persistence file
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
- [`citizens-united.ts`](./citizens-united.ts) - Legal document with citation detection
- [`hiking.ts`](./hiking.ts) - Simple local file, no processing
- [`arxiv.ts`](./arxiv.ts) - API integration with metadata
- [`prometheus-bound.ts`](./prometheus-bound.ts) - Text extraction with smart chunking
