/**
 * Authenticated Resource Proxy API Route
 *
 * Proxies resource representation requests to the backend with authentication headers.
 * This is necessary because browser <img> tags and other elements can't send auth headers.
 *
 * Supports any content type - forwards Accept header from client to backend.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { SERVER_API_URL } from '@/lib/env';
import { SemiontApiClient, resourceUri, type ResourceUri, type AccessToken, type BaseUrl, type ContentFormat } from '@semiont/api-client';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Get user session for authentication
  const session = await getServerSession(authOptions);

  if (!session?.backendToken) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const backendUrl = SERVER_API_URL;

  // Get Accept header and strip JSON-LD/JSON values
  // This proxy is for raw representations only - JSON metadata should use the API client directly
  let acceptHeader = request.headers.get('accept') || '*/*';

  // Remove application/ld+json and application/json from Accept header
  // so backend's content negotiation returns raw representations
  acceptHeader = acceptHeader
    .split(',')
    .map(type => type.trim())
    .filter(type => type !== 'application/ld+json' && type !== 'application/json')
    .join(', ') || '*/*';

  try {
    // Create api-client with session token
    const client = new SemiontApiClient({
      baseUrl: backendUrl as BaseUrl,
      accessToken: session.backendToken as AccessToken,
    });

    // Get resource representation as stream (avoids loading entire file into memory)
    const rUri = resourceUri(`${backendUrl}/resources/${id}`);
    const { stream, contentType } = await client.getResourceRepresentationStream(rUri as ResourceUri, {
      accept: acceptHeader as ContentFormat,
    });

    // Stream through to client - NextResponse accepts ReadableStream
    // Backend connection stays open until stream is fully consumed
    return new NextResponse(stream, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable', // Cache content-addressed resources aggressively
      },
    });
  } catch (error) {
    console.error('Resource proxy error:', error);
    return new NextResponse('Failed to fetch resource', { status: 500 });
  }
}
