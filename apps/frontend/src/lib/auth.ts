import GoogleProvider from 'next-auth/providers/google';
import CredentialsProvider from 'next-auth/providers/credentials';
import { validateData, JWTTokenSchema } from '@semiont/api-client';
import { OAuthUserSchema } from '@/lib/validation';
import {
  NEXT_PUBLIC_API_URL,
  NEXT_PUBLIC_ENABLE_LOCAL_AUTH,
  getAllowedDomains
} from '@/lib/env';
import type { NextAuthOptions } from 'next-auth';

console.log('[Frontend Auth] Config loaded:', {
  enableLocalAuth: NEXT_PUBLIC_ENABLE_LOCAL_AUTH,
  backendUrl: NEXT_PUBLIC_API_URL,
  allowedDomains: getAllowedDomains()
});

// Build providers array based on environment
const providers: NextAuthOptions['providers'] = [];

console.log('[Frontend Auth] Environment check:', {
  NODE_ENV: process.env.NODE_ENV,
  hasGoogleClientId: !!process.env.GOOGLE_CLIENT_ID,
  localAuthEnabled: NEXT_PUBLIC_ENABLE_LOCAL_AUTH
});

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

// Add password provider if enabled in config
if (NEXT_PUBLIC_ENABLE_LOCAL_AUTH) {
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

        const apiUrl = NEXT_PUBLIC_API_URL;

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
}

export const authOptions: NextAuthOptions = {
  providers,
  callbacks: {
    async signIn({ user, account }) {
      // Local development auth - already validated
      if (account?.provider === 'credentials') {
        return true;
      }

      if (account?.provider === 'google') {
        // Get allowed domains from environment
        const allowedDomains = getAllowedDomains();

        if (!allowedDomains || allowedDomains.length === 0) {
          console.error('site.oauthAllowedDomains is not configured - rejecting all OAuth logins');
          return false;
        }

        console.log(`OAuth Debug: Allowed domains from config = ${JSON.stringify(allowedDomains)}`);

        if (!user.email) {
          console.log('OAuth Debug: No email provided');
          return false;
        }

        const emailParts = user.email.split('@');
        if (emailParts.length !== 2 || !emailParts[1]) {
          console.log(`OAuth Debug: Invalid email format: ${user.email}`);
          return false;
        }

        const emailDomain: string = emailParts[1];
        console.log(`OAuth Debug: email=${user.email}, domain=${emailDomain}`);

        // Check if the domain is in the allowed list
        if (!allowedDomains.includes(emailDomain)) {
          console.log(`Rejected login from domain: ${emailDomain} (allowed: ${allowedDomains.join(', ')})`);
          return false;
        }

        console.log(`OAuth Debug: domain ${emailDomain} is allowed`);

        // Backend authentication for security validation and token generation
        try {
          const apiUrl = NEXT_PUBLIC_API_URL;
          console.log(`Calling backend at: ${apiUrl}/api/tokens/google`);
          const response = await fetch(`${apiUrl}/api/tokens/google`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              access_token: account.access_token,
              email: user.email, // Send for backend logging/analytics
            }),
          });

          if (!response.ok) {
            console.error('Backend authentication failed:', await response.text());
            return false;
          }

          const data = await response.json();
          
          // Validate backend token
          const tokenValidation = validateData(JWTTokenSchema, data.token);
          if (!tokenValidation.success) {
            console.error('Invalid backend token received:', tokenValidation.error);
            return false;
          }
          
          // Validate user data
          const userValidation = validateData(OAuthUserSchema, data.user);
          if (!userValidation.success) {
            console.error('Invalid user data received:', userValidation.error);
            return false;
          }
          
          // Store our validated backend token and user in the user object
          user.backendToken = tokenValidation.data;
          // Convert null to undefined for name and image to match expected types
          const validatedUser = userValidation.data;
          user.backendUser = {
            ...validatedUser,
            name: validatedUser.name === null ? undefined : validatedUser.name,
            image: validatedUser.image === null ? undefined : validatedUser.image,
          };
          // Store isNewUser in a way TypeScript accepts
          if ('__isNewUser' in user) {
            user.__isNewUser = data.isNewUser;
          } else {
            Object.defineProperty(user, '__isNewUser', {
              value: data.isNewUser,
              writable: true,
              configurable: true
            });
          }
          
          return true;
        } catch (error) {
          console.error('Authentication error:', error);
          return false;
        }
      }
      
      return true;
    },
    
    async jwt({ token, user }) {
      // Pass backend token to JWT
      if (user?.backendToken) {
        // Validate token structure before storing
        const validation = validateData(JWTTokenSchema, user.backendToken);
        if (validation.success && user.backendUser) {
          token.backendToken = validation.data;
          token.backendUser = user.backendUser;
          if ('__isNewUser' in user && typeof user.__isNewUser === 'boolean') {
            token.isNewUser = user.__isNewUser;
          }
        } else {
          console.error('Invalid token in JWT callback:', validation.success ? 'No backend user' : validation.error);
        }
      }
      return token;
    },
    
    async session({ session, token }) {
      // Pass backend token to session
      if (token.backendToken && token.backendUser) {
        // Re-validate token before adding to session
        const validation = validateData(JWTTokenSchema, token.backendToken);
        if (validation.success) {
          session.backendToken = validation.data;
          session.backendUser = token.backendUser;
          // Also populate standard session.user fields with isAdmin
          if (session.user && token.backendUser) {
            session.user.isAdmin = token.backendUser.isAdmin;
          }
          if (token.isNewUser !== undefined) {
            session.isNewUser = token.isNewUser;
          }
        } else {
          console.error('Invalid token in session callback:', validation.success ? 'Unknown error' : validation.error);
          // Don't pass invalid tokens to the client
          delete session.backendToken;
          delete session.backendUser;
        }
      }
      return session;
    },
    
  },
  pages: {
    signIn: '/auth/signin',
    error: '/auth/error',
  },
  // Add security options
  session: {
    strategy: 'jwt',
    maxAge: 8 * 60 * 60, // 8 hours
  },
  jwt: {
    maxAge: 8 * 60 * 60, // 8 hours
  },
  cookies: {
    sessionToken: {
      name: 'next-auth.session-token',
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: process.env.NODE_ENV === 'production',
      },
    },
  },
};