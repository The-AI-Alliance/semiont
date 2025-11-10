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

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  // Get user session for authentication
  const session = await getServerSession(authOptions);

  if (!session?.backendToken) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const { id } = params;
  const backendUrl = process.env.NEXT_PUBLIC_API_URL;

  if (!backendUrl) {
    return new NextResponse('Backend URL not configured', { status: 500 });
  }

  // Get Accept header and strip JSON-LD/JSON values
  // This proxy is for raw representations only - JSON metadata should use the API client
  let acceptHeader = request.headers.get('accept') || '*/*';

  // Remove application/ld+json and application/json from Accept header
  // so backend's content negotiation returns raw representations
  acceptHeader = acceptHeader
    .split(',')
    .map(type => type.trim())
    .filter(type => !type.includes('application/ld+json') && !type.includes('application/json'))
    .join(', ') || '*/*';

  try {
    // Forward request to backend with authentication
    const response = await fetch(`${backendUrl}/resources/${id}`, {
      headers: {
        'Authorization': `Bearer ${session.backendToken}`,
        'Accept': acceptHeader,
      },
    });

    if (!response.ok) {
      return new NextResponse(`Backend error: ${response.statusText}`, {
        status: response.status
      });
    }

    // Get the content type from backend response
    const contentType = response.headers.get('content-type') || 'application/octet-stream';

    // Stream the resource data back to client
    const data = await response.arrayBuffer();

    return new NextResponse(data, {
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
