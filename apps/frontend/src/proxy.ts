import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';

const handleI18nRouting = createMiddleware(routing);

/**
 * Parse and decode a JWT payload without verifying the signature.
 * Verification happens on the backend — here we only need the claims for routing.
 */
function parseJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) return null;
    return JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // First, handle i18n routing
  const response = handleI18nRouting(request);

  // Extract locale from pathname (format: /[locale]/...)
  const localeMatch = pathname.match(/^\/([a-z]{2})(\/|$)/);
  const pathWithoutLocale = localeMatch ? pathname.slice(3) : pathname;

  // Read the backend-issued JWT cookie
  const token = request.cookies.get('semiont-token')?.value;
  const payload = token ? parseJwtPayload(token) : null;

  // Apply auth middleware to admin routes
  if (pathWithoutLocale.startsWith('/admin')) {
    if (!payload || !(payload as any).isAdmin) {
      return NextResponse.rewrite(new URL('/404', request.url));
    }
  }

  // Apply auth middleware to moderate routes
  if (pathWithoutLocale.startsWith('/moderate')) {
    if (!payload || (!(payload as any).isModerator && !(payload as any).isAdmin)) {
      return NextResponse.rewrite(new URL('/404', request.url));
    }
  }

  return response;
}

export const config = {
  // Match all pathnames except for
  // - /api (API routes)
  // - /_next (Next.js internals)
  // - /_vercel (Vercel internals)
  // - /static (static files)
  // - /*.* (files with extensions, e.g. favicon.ico)
  matcher: ['/((?!api|_next|_vercel|static|.*\\..*).*)']
};
