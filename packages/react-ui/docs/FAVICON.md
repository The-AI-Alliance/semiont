# Favicon Assets

The `@semiont/react-ui` package includes a complete set of Semiont-branded favicons in multiple formats.

## Available Files

All favicon files are available in `node_modules/@semiont/react-ui/public/favicons/`:

- **favicon.ico** - Multi-resolution icon (16x16, 32x32, 48x48)
- **favicon.svg** - Scalable vector format
- **favicon-16x16.png**, **favicon-32x32.png** - Standard sizes
- **apple-touch-icon.png** - 180x180 for iOS devices
- **android-chrome-192x192.png**, **android-chrome-512x512.png** - Android icons
- **site.webmanifest** - PWA manifest file

## Using Favicons in Your App

### Option 1: Copy During Build (Recommended)

Create a script to copy favicons to your public directory:

```javascript
// scripts/copy-favicons.js
const fs = require('fs');
const path = require('path');

const sourceDir = path.join(__dirname, '../node_modules/@semiont/react-ui/public/favicons');
const targetDir = path.join(__dirname, '../public');

const files = [
  'favicon.ico', 'favicon.svg', 'favicon-16x16.png', 'favicon-32x32.png',
  'apple-touch-icon.png', 'android-chrome-192x192.png',
  'android-chrome-512x512.png', 'site.webmanifest'
];

files.forEach(file => {
  fs.copyFileSync(
    path.join(sourceDir, file),
    path.join(targetDir, file)
  );
});
```

Add to your build process:
```json
{
  "scripts": {
    "build": "node scripts/copy-favicons.js && your-build-command"
  }
}
```

### Option 2: Manual Setup

Copy the files from `node_modules/@semiont/react-ui/public/favicons/` to your public directory.

### Option 3: Use the React Component

For inline SVG usage in your app:

```tsx
import { SemiontFavicon } from '@semiont/react-ui';

function Header() {
  return (
    <div className="header">
      <SemiontFavicon size={40} variant="gradient" />
      <span>My Semiont App</span>
    </div>
  );
}
```

## HTML Setup

Add to your HTML head:

```html
<link rel="icon" href="/favicon.ico" />
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<link rel="manifest" href="/site.webmanifest" />
```

Or in Next.js metadata:

```tsx
export const metadata = {
  icons: {
    icon: [
      { url: '/favicon.ico' },
      { url: '/favicon.svg', type: 'image/svg+xml' }
    ],
    apple: '/apple-touch-icon.png'
  },
  manifest: '/site.webmanifest'
};
```

## React Component API

The `SemiontFavicon` component accepts the following props:

```tsx
interface SemiontFaviconProps {
  size?: number;        // Default: 32
  className?: string;   // Additional CSS classes
  variant?: 'gradient' | 'solid' | 'outline';  // Default: 'gradient'
  background?: boolean; // Include dark background. Default: true
}
```

## Regenerating Favicons

To regenerate the favicon files from the source SVG:

1. Navigate to the react-ui package
2. Run the generation script:
   ```bash
   cd packages/react-ui
   python scripts/generate-favicons.py
   ```

The script requires Python with the following packages:
- `cairosvg` - For SVG to PNG conversion
- `Pillow` - For image processing and ICO generation

## Design Specifications

- **Letter**: Capital "S" from "SEMIONT"
- **Font**: Orbitron (bold weight)
- **Colors**: Cyan to blue gradient (#00FFFF to #0080FF)
- **Background**: Dark (#1a1a1a)
- **Style**: Futuristic, geometric, consistent with Semiont branding