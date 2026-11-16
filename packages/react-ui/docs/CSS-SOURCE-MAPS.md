# CSS Source Maps for @semiont/react-ui

## Overview
Source maps help you debug CSS by mapping the bundled/minified styles back to their original source files. This makes it much easier to find and fix styling issues during development.

## Quick Start

### Using Pre-built CSS
If you're importing our pre-built CSS, source maps are already included:

```javascript
// Your app
import '@semiont/react-ui/styles';
```

The source map file (`index.css.map`) is automatically generated alongside the CSS when the package is built.

### Building from Source
If you're building the CSS yourself:

```bash
# Install dependencies
npm install --save-dev postcss postcss-cli postcss-import autoprefixer

# Build with source maps (development)
npx postcss node_modules/@semiont/react-ui/src/styles/index.css \
  -o ./dist/semiont-ui.css \
  --map

# Build without source maps (production)
npx postcss node_modules/@semiont/react-ui/src/styles/index.css \
  -o ./dist/semiont-ui.css \
  --no-map
```

## Using Source Maps in Browser DevTools

### Chrome/Edge
1. Open DevTools (F12)
2. Go to **Sources** tab
3. Look for `webpack://` → `node_modules/@semiont/react-ui/src/styles/`
4. Browse the original CSS file structure
5. Click on any style in Elements tab to jump to source

### Firefox
1. Open DevTools (F12)
2. Go to **Style Editor** tab
3. Original CSS files appear automatically
4. Click file names to view/edit source

### Safari
1. Open Web Inspector
2. **Resources** → **Stylesheets**
3. Source files shown with original structure

## Build Tool Integration

### Webpack
```javascript
// webpack.config.js
module.exports = {
  devtool: 'source-map',
  module: {
    rules: [{
      test: /\.css$/,
      use: [
        'style-loader',
        {
          loader: 'css-loader',
          options: { sourceMap: true }
        }
      ]
    }]
  }
};
```

### Vite
```javascript
// vite.config.js
export default {
  css: {
    devSourcemap: true
  }
};
```

### Next.js
Source maps are enabled by default in development. For production:

```javascript
// next.config.js
module.exports = {
  productionBrowserSourceMaps: true // Optional: enable in production
};
```

### Create React App
Source maps are automatically included in development builds.

## Custom PostCSS Configuration

If you need to customize the CSS processing:

```javascript
// postcss.config.js
module.exports = {
  map: {
    inline: false,
    annotation: true,
    sourcesContent: true
  },
  plugins: {
    'postcss-import': {},
    'autoprefixer': {}
  }
};
```

## File Structure
When source maps are enabled, you'll see this structure in DevTools:

```
@semiont/react-ui/src/styles/
├── index.css           # Main entry point
├── variables.css       # Design tokens
├── base/              # Reset and utilities
├── components/        # Component styles
├── features/          # Feature-specific styles
├── layout/            # Layout system
├── patterns/          # Common patterns
└── utilities/         # Accessibility utilities
```

## Troubleshooting

### Source maps not showing in DevTools
1. Check that the CSS file has `/*# sourceMappingURL=index.css.map */` at the end
2. Ensure the `.map` file exists next to the CSS file
3. Verify DevTools settings have source maps enabled
4. Check network tab to see if `.map` file loads

### Wrong file paths in source maps
- Make sure you're using the correct import path
- Check that `node_modules` is not excluded in your bundler config

### Production builds
By default, production builds may not include source map references for security. To enable:
- Set appropriate environment variables
- Configure your bundler to include source maps
- Serve `.map` files conditionally (authenticated users only)

## Security Considerations

For production deployments:
- Consider serving source maps only to authenticated developers
- Use conditional middleware to restrict `.map` file access
- Or disable source map references entirely in production CSS

Example with Express:
```javascript
app.use('*.map', (req, res, next) => {
  if (process.env.NODE_ENV === 'development') {
    next();
  } else {
    res.status(404).end();
  }
});
```

## Need Help?
- Check if source maps are loading in Network tab
- Verify your bundler configuration
- Ensure PostCSS is processing the CSS correctly
- File an issue if you encounter problems

---

*Source maps make debugging CSS much easier by showing you exactly where styles come from in the original source files.*