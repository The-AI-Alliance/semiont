import { NextRequest, NextResponse } from 'next/server';
import { SERVER_API_URL } from '@/lib/env';
import type { BaseUrl, AccessToken } from '@semiont/core';
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

  const isAllowedCallback = allowedCallbackPatterns.some(pattern => pattern.test(callback));

  if (!isAllowedCallback) {
    return NextResponse.json({ error: 'Invalid callback URL. Must be a localhost URL for CLI authentication.' }, { status: 400 });
  }

  // Read the semiont-token cookie set by the backend
  const token = request.cookies.get('semiont-token')?.value;

  if (!token) {
    const host = request.headers.get('host') || 'localhost:3000';
    const protocol = request.headers.get('x-forwarded-proto') || 'http';
    const currentUrl = `${protocol}://${host}${request.nextUrl.pathname}${request.nextUrl.search}`;
    const signInUrl = `${protocol}://${host}/auth/signin?callbackUrl=${encodeURIComponent(currentUrl)}`;
    return NextResponse.redirect(signInUrl);
  }

  try {
    const client = new SemiontApiClient({
      baseUrl: SERVER_API_URL as BaseUrl,
    });

    const data = await client.generateMCPToken({ auth: token as AccessToken });
    const refreshToken = data.refresh_token;

    return NextResponse.redirect(`${callback}?token=${refreshToken}`);
  } catch (error) {
    console.error('MCP setup error:', error);
    return NextResponse.json({ error: 'Failed to generate refresh token' }, { status: 500 });
  }
}
