/**
 * Security Headers Middleware
 *
 * Adds security headers to all responses to protect against common attacks:
 * - X-Frame-Options: Prevents clickjacking
 * - X-Content-Type-Options: Prevents MIME sniffing
 * - Strict-Transport-Security: Enforces HTTPS
 * - Content-Security-Policy: Prevents XSS
 * - X-XSS-Protection: Browser XSS filter
 * - Referrer-Policy: Controls referrer information
 * - Permissions-Policy: Controls browser features
 */

import { MiddlewareHandler } from 'hono';

export const securityHeaders = (): MiddlewareHandler => {
  return async (c, next) => {
    await next();

    // X-Frame-Options: Prevent clickjacking by disallowing the page to be framed
    c.res.headers.set('X-Frame-Options', 'DENY');

    // X-Content-Type-Options: Prevent MIME sniffing
    c.res.headers.set('X-Content-Type-Options', 'nosniff');

    // Strict-Transport-Security: Enforce HTTPS for 1 year, including subdomains
    // Only set in production to avoid issues in local development
    if (process.env.NODE_ENV === 'production') {
      c.res.headers.set(
        'Strict-Transport-Security',
        'max-age=31536000; includeSubDomains'
      );
    }

    // Content-Security-Policy: Restrict resource loading to prevent XSS.
    // The default for API responses is the strictest possible policy. The
    // Swagger UI route (`/api/docs`) is the one HTML-rendering exception:
    // it needs to load Swagger UI's CDN-hosted JS/CSS, run its init shim,
    // and fetch the OpenAPI JSON from this origin.
    const isSwaggerUi = c.req.path === '/api/docs' || c.req.path === '/api/swagger';
    const csp = isSwaggerUi
      ? [
          "default-src 'none'",
          "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
          "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
          "img-src 'self' data: https://cdn.jsdelivr.net",
          "font-src 'self' https://cdn.jsdelivr.net",
          "connect-src 'self'",
          "frame-ancestors 'none'",
          "base-uri 'self'",
          "form-action 'none'",
        ].join('; ')
      : [
          "default-src 'none'",         // Block everything by default
          "frame-ancestors 'none'",     // Don't allow framing (backup to X-Frame-Options)
          "base-uri 'none'",            // Prevent base tag injection
          "form-action 'none'",         // No form submissions from this origin
        ].join('; ');
    c.res.headers.set('Content-Security-Policy', csp);

    // X-XSS-Protection: Enable browser's XSS filter (legacy, but doesn't hurt)
    c.res.headers.set('X-XSS-Protection', '1; mode=block');

    // Referrer-Policy: Don't send referrer information
    c.res.headers.set('Referrer-Policy', 'no-referrer');

    // Permissions-Policy: Disable all browser features
    // This is an API, we don't need camera, geolocation, etc.
    const permissions = [
      'camera=()',
      'geolocation=()',
      'microphone=()',
      'payment=()',
      'usb=()',
      'interest-cohort=()',  // Disable FLoC tracking
    ].join(', ');
    c.res.headers.set('Permissions-Policy', permissions);
  };
};
