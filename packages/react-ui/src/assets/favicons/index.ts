// Export favicon URLs for static use
export const faviconPaths = {
  ico: '/favicons/favicon.ico',
  svg: '/favicons/favicon.svg',
  appleTouchIcon: '/favicons/apple-touch-icon.png',
  favicon32: '/favicons/favicon-32x32.png',
  favicon16: '/favicons/favicon-16x16.png',
  androidChrome192: '/favicons/android-chrome-192x192.png',
  androidChrome512: '/favicons/android-chrome-512x512.png',
  manifest: '/favicons/site.webmanifest'
} as const;

// Export React component for inline use
export { SemiontFavicon } from './SemiontFavicon';