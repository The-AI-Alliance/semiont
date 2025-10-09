import { http, HttpResponse } from 'msw'

// Types
interface User {
  id: string
  email: string
  name: string
  domain: string
  provider: string
  isAdmin: boolean
  isActive: boolean
  lastLogin: string | null
  created: string
  updatedAt: string
}

// Mock data
const mockUser: User = {
  id: 'user123',
  email: 'test@example.com',
  name: 'Test User',
  domain: 'example.com',
  provider: 'google',
  isAdmin: false,
  isActive: true,
  lastLogin: null,
  created: '2024-01-01',
  updatedAt: '2024-01-01'
}

const mockAdminUser: User = {
  ...mockUser,
  id: 'admin123',
  email: 'admin@example.com',
  isAdmin: true
}

// Define handlers for all API routes
const handlers = [
  // Authentication endpoints
  http.post('*/api/tokens/google', () => {
    return HttpResponse.json({
      token: 'mock-jwt-token',
      user: mockUser,
      isNewUser: false
    })
  }),

  http.get('*/api/auth/me', ({ request }) => {
    const authHeader = request.headers.get('authorization')
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return HttpResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    return HttpResponse.json({
      ...mockUser,
      termsAcceptedAt: null // Default to null, can be overridden in tests
    })
  }),

  http.post('*/api/users/accept-terms', ({ request }) => {
    const authHeader = request.headers.get('authorization')
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return HttpResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    return HttpResponse.json({
      success: true,
      termsAcceptedAt: new Date().toISOString()
    })
  }),

  // Cookie endpoints
  http.get('*/api/cookies/export', ({ request }) => {
    // Check for authentication
    const authHeader = request.headers.get('authorization')
    if (!authHeader) {
      return HttpResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const exportData = {
      exportDate: new Date().toISOString(),
      userId: mockUser.id,
      consent: {
        necessary: true,
        analytics: false,
        marketing: false,
        preferences: true,
        timestamp: new Date().toISOString()
      },
      cookies: {
        'user-preferences': {
          theme: 'light',
          language: 'en'
        }
      },
      dataRetentionPolicy: 'User data is retained for 2 years unless consent is withdrawn.',
      userRights: [
        'Right to access your data',
        'Right to correct your data',
        'Right to delete your data',
        'Right to data portability'
      ]
    }

    return new Response(JSON.stringify(exportData, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="cookie-data-export-${Date.now()}.json"`
      }
    })
  }),

  http.post('*/api/cookies/consent', async ({ request }) => {
    const body = await request.json()
    
    return HttpResponse.json({
      success: true,
      consent: body
    })
  }),

  http.delete('*/api/cookies/delete', () => {
    return HttpResponse.json({
      success: true,
      message: 'All cookie data deleted'
    })
  }),

  // Admin endpoints
  http.get('*/api/admin/users', ({ request }) => {
    // Check for admin auth
    const isAdmin = request.headers.get('x-admin') === 'true'
    if (!isAdmin) {
      return HttpResponse.json(
        { error: 'Forbidden' },
        { status: 403 }
      )
    }

    return HttpResponse.json({
      users: [mockUser, mockAdminUser],
      total: 2,
      page: 1,
      pageSize: 10
    })
  }),

  http.delete('*/api/admin/users/:id', ({ params }) => {
    const { id } = params
    
    return HttpResponse.json({
      success: true,
      message: `User ${id} deleted`
    })
  }),

  http.patch('*/api/admin/users/:id/toggle-admin', ({ params }) => {
    const { id } = params
    
    return HttpResponse.json({
      success: true,
      user: { ...mockUser, id, isAdmin: true }
    })
  }),

  http.get('*/api/admin/oauth/config', () => {
    return HttpResponse.json({
      success: true,
      providers: [
        {
          name: 'google',
          clientId: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID,
          isConfigured: !!process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID,
          scopes: ['openid', 'email', 'profile']
        },
        {
          name: 'github',
          clientId: undefined,
          isConfigured: false
        }
      ],
      allowedDomains: process.env.NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS?.split(',').map(d => d.trim()) || []
    })
  })
]

// Error handlers for testing error scenarios
const errorHandlers = [
  http.get('*/api/cookies/export', () => {
    return HttpResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    )
  }),

  http.post('*/api/cookies/consent', () => {
    return HttpResponse.json(
      { success: false, error: 'Database error' },
      { status: 500 }
    )
  }),

  http.get('*/api/auth/me', () => {
    return HttpResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }),

  http.post('*/api/users/accept-terms', () => {
    return HttpResponse.json(
      { success: false, error: 'Failed to save terms acceptance' },
      { status: 500 }
    )
  })
]

// Network error handlers
const networkErrorHandlers = [
  http.get('*/api/*', () => {
    return HttpResponse.error()
  }),
  
  http.post('*/api/*', () => {
    return HttpResponse.error()
  })
]

export { handlers, errorHandlers, networkErrorHandlers }