import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const callback = searchParams.get('callback');
  
  if (!callback) {
    return NextResponse.json({ error: 'Callback URL required' }, { status: 400 });
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
    // Call backend to generate refresh token
    const backendUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
    const response = await fetch(`${backendUrl}/api/auth/mcp-generate-token`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.backendToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      console.error('Failed to generate refresh token:', response.status);
      return NextResponse.json({ error: 'Failed to generate refresh token' }, { status: 500 });
    }

    const data = await response.json();
    const refreshToken = data.refresh_token;

    // Redirect to CLI callback with token
    return NextResponse.redirect(`${callback}?token=${refreshToken}`);
  } catch (error) {
    console.error('MCP setup error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}