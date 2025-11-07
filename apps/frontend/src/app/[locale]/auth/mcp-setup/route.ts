import { NextRequest, NextResponse } from 'next/server';
import { NEXT_PUBLIC_API_URL } from '@/lib/env';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth';
import { SemiontApiClient } from '@semiont/api-client';

// Mark this route as dynamic to prevent static optimization during build
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const callback = searchParams.get('callback');
  
  if (!callback) {
    return NextResponse.json({ error: 'Callback URL required' }, { status: 400 });
  }

  // Allow localhost callbacks for MCP CLI (following Google OAuth pattern)
  const allowedCallbackPatterns = [
    /^http:\/\/localhost:\d+\/.*$/,
    /^http:\/\/127\.0\.0\.1:\d+\/.*$/,
    /^http:\/\/\[::1\]:\d+\/.*$/,  // IPv6 localhost
  ];

  // In production, only allow localhost callbacks
  // In development, you might want to allow other patterns
  const isAllowedCallback = allowedCallbackPatterns.some(pattern => pattern.test(callback));
  
  if (!isAllowedCallback) {
    return NextResponse.json({ error: 'Invalid callback URL. Must be a localhost URL for CLI authentication.' }, { status: 400 });
  }

  // Get the user's session
  const session = await getServerSession(authOptions);
  
  if (!session || !session.backendToken) {
    // Not authenticated - redirect to sign in
    const host = request.headers.get('host') || 'wiki.pingel.org';
    const protocol = request.headers.get('x-forwarded-proto') || 'https';
    const currentUrl = `${protocol}://${host}${request.nextUrl.pathname}${request.nextUrl.search}`;
    const signInUrl = `${protocol}://${host}/api/auth/signin?callbackUrl=${encodeURIComponent(currentUrl)}`;
    return NextResponse.redirect(signInUrl);
  }

  try {
    // Create api-client with user's token
    const client = new SemiontApiClient({
      baseUrl: NEXT_PUBLIC_API_URL,
      accessToken: session.backendToken
    });

    // Generate MCP refresh token using api-client
    const data = await client.generateMCPToken();
    const refreshToken = data.refresh_token;

    // Redirect to CLI callback with token
    return NextResponse.redirect(`${callback}?token=${refreshToken}`);
  } catch (error) {
    console.error('MCP setup error:', error);
    return NextResponse.json({ error: 'Failed to generate refresh token' }, { status: 500 });
  }
}