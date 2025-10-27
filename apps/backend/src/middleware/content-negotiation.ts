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

  // Check if Accept header explicitly includes text/html
  const acceptsHtml = acceptHeader.includes('text/html');

  // Check if User-Agent indicates a browser
  const isBrowser = userAgent.includes('Mozilla') || userAgent.includes('Chrome') || userAgent.includes('Safari');

  // Prefer HTML if either Accept header includes it OR it's a browser
  return acceptsHtml || isBrowser;
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
