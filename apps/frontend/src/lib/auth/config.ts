import { validateData, JWTTokenSchema } from '@semiont/api-client';
import { OAuthUserSchema } from '@semiont/react-ui';
import {
  SERVER_API_URL,
  getAllowedDomains
} from '@/lib/env';
import type { NextAuthOptions } from 'next-auth';
import { providers } from './providers';

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

        if (!user.email) {
          return false;
        }

        const emailParts = user.email.split('@');
        if (emailParts.length !== 2 || !emailParts[1]) {
          return false;
        }

        const emailDomain: string = emailParts[1];

        // Check if the domain is in the allowed list
        if (!allowedDomains.includes(emailDomain)) {
          return false;
        }

        // Backend authentication for security validation and token generation
        try {
          const apiUrl = SERVER_API_URL;
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
