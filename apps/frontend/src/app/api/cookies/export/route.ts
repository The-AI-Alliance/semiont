import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';

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

// GET - Export user's cookie data for GDPR compliance
export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    
    if (!session?.backendUser) {
      return NextResponse.json({ success: false, error: 'Not authenticated' }, { status: 401 });
    }

    const exportData: CookieExportData = {
      user: {
        id: session.backendUser.id,
        email: session.backendUser.email
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