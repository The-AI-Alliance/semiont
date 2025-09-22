import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // Only apply middleware to admin routes
  if (pathname.startsWith('/admin')) {
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
      // We need to check the backendUser.isAdmin flag
      if (!token || !(token as any).backendUser?.isAdmin) {
        // Return 404 instead of 401/403 to hide the existence of admin routes
        // This is a security best practice - don't reveal what exists
        return NextResponse.rewrite(new URL('/404', request.url));
      }
    } catch (error) {
      // If there's any error checking auth, return 404
      console.error('Middleware auth error:', error);
      return NextResponse.rewrite(new URL('/404', request.url));
    }
  }

  return NextResponse.next();
}

// Configure which routes the middleware runs on
export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api/auth (auth endpoints need to be accessible)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    '/((?!api/auth|_next/static|_next/image|favicon.ico).*)',
  ],
};