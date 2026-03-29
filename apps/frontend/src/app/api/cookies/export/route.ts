import { NextRequest, NextResponse } from 'next/server';

// Mark this route as dynamic since it uses session data
export const dynamic = 'force-dynamic';

export interface CookieExportData {
  user: {
    id: string;
    email: string;
  };
  consent: {
    necessary: boolean;
    analytics: boolean;
    marketing: boolean;
    preferences: boolean;
    timestamp: string;
    version: string;
  };
  exportDate: string;
  dataRetentionPolicy: string;
}

function parseJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) return null;
    return JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

// GET - Export user's cookie data for GDPR compliance
export async function GET(request: NextRequest) {
  try {
    const tokenStr = request.cookies.get('semiont-token')?.value;
    if (!tokenStr) {
      return NextResponse.json({ success: false, error: 'Not authenticated' }, { status: 401 });
    }
    const payload = parseJwtPayload(tokenStr);
    if (!payload) {
      return NextResponse.json({ success: false, error: 'Not authenticated' }, { status: 401 });
    }

    const exportData: CookieExportData = {
      user: {
        id: (payload.sub ?? payload.id ?? '') as string,
        email: (payload.email ?? '') as string,
      },
      consent: {
        necessary: true,
        analytics: false,
        marketing: false,
        preferences: false,
        timestamp: new Date().toISOString(),
        version: '1.0'
      },
      exportDate: new Date().toISOString(),
      dataRetentionPolicy: 'Cookie consent data is retained for 2 years from last update or until explicitly withdrawn.'
    };

    // Set headers for file download
    const headers = {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="cookie-data-export-${Date.now()}.json"`
    };

    return new NextResponse(JSON.stringify(exportData, null, 2), { headers });
  } catch (error) {
    console.error('Failed to export cookie data:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}