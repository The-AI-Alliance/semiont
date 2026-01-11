import GoogleProvider from 'next-auth/providers/google';
import CredentialsProvider from 'next-auth/providers/credentials';
import { SERVER_API_URL } from '@/lib/env';
import type { NextAuthOptions } from 'next-auth';

console.log('[Frontend Auth] Environment check:', {
  NODE_ENV: process.env.NODE_ENV,
  hasGoogleClientId: !!process.env.GOOGLE_CLIENT_ID
});

// Build providers array based on environment
export const providers: NextAuthOptions['providers'] = [];

// Add Google provider if credentials are configured
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  console.log('[Frontend Auth] Adding Google provider');
  providers.push(
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    })
  );
}

// Always add password/credentials provider - it will only be shown if configured
console.log('[Frontend Auth] Adding password credentials provider');
providers.push(
  CredentialsProvider({
    name: 'Password',
    credentials: {
      email: { label: "Email", type: "email", placeholder: "admin@example.com" },
      password: { label: "Password", type: "password" }
    },
    async authorize(credentials) {
      if (!credentials?.email || !credentials?.password) {
        return null;
      }

      const apiUrl = SERVER_API_URL;

      try {
        console.log('[Frontend Auth] Calling backend for password auth:', {
          apiUrl,
          endpoint: `${apiUrl}/api/tokens/password`,
          email: credentials.email
        });

        const response = await fetch(`${apiUrl}/api/tokens/password`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            email: credentials.email,
            password: credentials.password,
          }),
        });

        console.log('[Frontend Auth] Backend response:', {
          status: response.status,
          statusText: response.statusText,
          ok: response.ok
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error('[Frontend Auth] Password authentication failed:', errorText);
          return null;
        }

        const data = await response.json();

        // Return user object with backend token
        return {
          id: data.user.id,
          email: data.user.email,
          name: data.user.name || 'User',
          image: data.user.image,
          backendToken: data.token,
          backendUser: data.user,
        };
      } catch (error) {
        console.error('Password authentication error:', error);
        return null;
      }
    }
  })
);
