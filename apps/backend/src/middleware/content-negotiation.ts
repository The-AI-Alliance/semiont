/**
 * Content Negotiation Middleware
 *
 * Handles W3C-compliant content negotiation for document and annotation URIs.
 *
 * Per W3C Web Annotation Data Model:
 * - Document/Annotation URIs MUST be globally resolvable
 * - When Accept: application/ld+json -> return JSON-LD representation
 * - When Accept: text/html -> redirect to frontend viewer
 * - Default to JSON-LD for API clients
 */

import { Context } from 'hono';

/**
 * Determines if request prefers HTML over JSON-LD
 *
 * Checks both Accept header and User-Agent to detect browsers vs API clients
 */
export function prefersHtml(c: Context): boolean {
  const acceptHeader = c.req.header('Accept') || '';
  const userAgent = c.req.header('User-Agent') || '';

  // Check what content types are accepted
  const acceptsHtml = acceptHeader.includes('text/html');
  const acceptsJson = acceptHeader.includes('application/json') || acceptHeader.includes('application/ld+json');

  // If Accept header has ONLY JSON (no HTML), definitely prefer JSON
  // This handles fetch() API calls: fetch() sends "Accept: application/json, */*;q=0.1" or similar
  if (acceptsJson && !acceptsHtml) {
    return false;
  }

  // If Accept header has both HTML and JSON, check which comes first (higher priority)
  // e.g., "text/html,application/json;q=0.9" -> HTML has higher priority
  // e.g., "application/json,text/html;q=0.9" -> JSON has higher priority
  if (acceptsHtml && acceptsJson) {
    const htmlIndex = acceptHeader.indexOf('text/html');
    const jsonIndex = Math.min(
      acceptHeader.indexOf('application/json') >= 0 ? acceptHeader.indexOf('application/json') : Infinity,
      acceptHeader.indexOf('application/ld+json') >= 0 ? acceptHeader.indexOf('application/ld+json') : Infinity
    );
    // If HTML appears first, prefer HTML (browser navigation)
    // If JSON appears first, prefer JSON (API call)
    if (htmlIndex < jsonIndex) {
      return true;
    } else {
      return false;
    }
  }

  // Check if User-Agent indicates a browser (Mozilla, Chrome, Safari, Edge, etc.)
  const isBrowser = /Mozilla|Chrome|Safari|Edge|Firefox|Opera/.test(userAgent);

  // If User-Agent is a browser AND no Accept header specified, prefer HTML
  // This handles direct browser navigation without explicit Accept
  if (isBrowser && !acceptHeader && !userAgent.includes('curl')) {
    return true;
  }

  // If User-Agent is a browser AND accepts HTML (no JSON), prefer HTML
  // This handles direct browser navigation with HTML Accept
  if (isBrowser && acceptsHtml && !userAgent.includes('curl')) {
    return true;
  }

  // Default: only prefer HTML if Accept header explicitly includes text/html
  return acceptsHtml && !acceptsJson;
}

/**
 * Determines if request prefers JSON-LD
 *
 * JSON-LD is the W3C standard format for Web Annotations
 * Returns the opposite of prefersHtml() - they are mutually exclusive
 */
export function prefersJsonLd(c: Context): boolean {
  // If client prefers HTML, it doesn't prefer JSON-LD
  if (prefersHtml(c)) {
    return false;
  }

  const acceptHeader = c.req.header('Accept') || '';

  // Check for explicit JSON-LD request
  if (acceptHeader.includes('application/ld+json')) {
    return true;
  }

  // Check for generic JSON request (default to JSON-LD)
  if (acceptHeader.includes('application/json')) {
    return true;
  }

  // Default to JSON-LD for API clients
  return true;
}

/**
 * Gets the frontend URL from environment
 */
export function getFrontendUrl(): string {
  const frontendUrl = process.env.FRONTEND_URL;
  if (!frontendUrl) {
    throw new Error('FRONTEND_URL environment variable is required for content negotiation');
  }
  return frontendUrl;
}
