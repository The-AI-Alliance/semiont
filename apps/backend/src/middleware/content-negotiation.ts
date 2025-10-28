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

  // Check if Accept header explicitly includes text/html
  const acceptsHtml = acceptHeader.includes('text/html');

  // Check if Accept header includes JSON (API request)
  const acceptsJson = acceptHeader.includes('application/json') || acceptHeader.includes('application/ld+json');

  // Only prefer HTML if:
  // 1. Accept header explicitly includes text/html
  // 2. AND doesn't prefer JSON (JSON takes precedence for API calls)
  // This ensures fetch() API calls get JSON, not redirects
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
