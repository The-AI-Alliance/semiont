import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';

const handleI18nRouting = createMiddleware(routing);

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // First, handle i18n routing
  const response = handleI18nRouting(request);

  // Extract locale from pathname (format: /[locale]/...)
  const localeMatch = pathname.match(/^\/([a-z]{2})(\/|$)/);
  const pathWithoutLocale = localeMatch ? pathname.slice(3) : pathname;

  // Only apply admin auth middleware to admin routes
  if (pathWithoutLocale.startsWith('/admin')) {
    try {
      const secret = process.env.NEXTAUTH_SECRET;
      if (!secret) {
        console.error('NEXTAUTH_SECRET is not set');
        return NextResponse.rewrite(new URL('/404', request.url));
      }

      const token = await getToken({
        req: request,
        secret
      });

      // Check if user is authenticated and is an admin
      if (!token || !(token as any).backendUser?.isAdmin) {
        // Return 404 instead of 401/403 to hide the existence of admin routes
        return NextResponse.rewrite(new URL('/404', request.url));
      }
    } catch (error) {
      console.error('Middleware auth error:', error);
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
