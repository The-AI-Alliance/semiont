import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';

// Mark this route as dynamic since it uses session data
export const dynamic = 'force-dynamic';

export interface CookieConsentRequest {
  necessary: boolean;
  analytics: boolean;
  marketing: boolean;
  preferences: boolean;
}

export interface CookieConsentResponse {
  success: boolean;
  consent?: CookieConsentRequest & {
    timestamp: string;
    version: string;
  };
  error?: string;
}

// GET - Get current user's cookie consent preferences
export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    
    if (!session?.backendUser) {
      return NextResponse.json({ success: false, error: 'Not authenticated' }, { status: 401 });
    }

    // For now, we'll return a placeholder response since cookie consent is stored client-side
    // In a real implementation, you might store preferences in the database
    return NextResponse.json({
      success: true,
      consent: {
        necessary: true,
        analytics: false,
        marketing: false,
        preferences: false,
        timestamp: new Date().toISOString(),
        version: '1.0'
      }
    });
  } catch (error) {
    console.error('Failed to get cookie consent:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// POST - Update user's cookie consent preferences
export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    
    if (!session?.backendUser) {
      return NextResponse.json({ success: false, error: 'Not authenticated' }, { status: 401 });
    }

    const body = await request.json();
    
    // Validate request body
    if (typeof body.necessary !== 'boolean' ||
        typeof body.analytics !== 'boolean' ||
        typeof body.marketing !== 'boolean' ||
        typeof body.preferences !== 'boolean') {
      return NextResponse.json(
        { success: false, error: 'Invalid consent data' },
        { status: 400 }
      );
    }

    // Ensure necessary cookies are always true
    if (!body.necessary) {
      return NextResponse.json(
        { success: false, error: 'Necessary cookies cannot be disabled' },
        { status: 400 }
      );
    }

    const consentData = {
      necessary: body.necessary,
      analytics: body.analytics,
      marketing: body.marketing,
      preferences: body.preferences,
      timestamp: new Date().toISOString(),
      version: '1.0'
    };

    // In a real implementation, you would store this in a database
    // For now, we'll just return the data as if it was saved
    
    return NextResponse.json({
      success: true,
      consent: consentData
    });
  } catch (error) {
    console.error('Failed to update cookie consent:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}