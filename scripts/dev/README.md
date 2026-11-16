# scripts/build — Dev Build Helpers

Dev-time build utilities. These require npm and run inside the repo.

## Scripts

| Script | Purpose |
|--------|---------|
| `build-packages.js` | Build all packages in dependency order |
| `build-css-with-sourcemaps.js` | Build CSS with source maps |

## Usage

```bash
npm run build:packages             # Build all library packages
npm run build:css                  # Build CSS
npm run build:css:watch            # Build CSS in watch mode
npm run build:css:prod             # Build CSS for production
```
