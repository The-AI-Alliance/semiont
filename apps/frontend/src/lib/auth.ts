import GoogleProvider from 'next-auth/providers/google';
import { JWTTokenSchema, OAuthUserSchema, validateData } from '@/lib/validation';
import type { NextAuthOptions } from 'next-auth';

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      // TODO: Fetch these from AWS Secrets Manager (semiont/oauth/google)
      // For local dev, these can be set as environment variables
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  callbacks: {
    async signIn({ user, account, profile }) {
      if (account?.provider === 'google') {
        // Check if email domain is allowed
        const allowedDomainsEnv = process.env.NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS || '';
        const allowedDomains = allowedDomainsEnv.split(',').map(d => d.trim());
        const domain = user.email?.split('@')[1];
        
        console.log(`OAuth Debug: email=${user.email}, domain=${domain}, allowedDomainsEnv='${allowedDomainsEnv}', allowedDomains=${JSON.stringify(allowedDomains)}`);
        
        if (!domain || !allowedDomains.includes(domain)) {
          console.log(`Rejected login from domain: ${domain}, allowed: ${JSON.stringify(allowedDomains)}`);
          return false;
        }

        // Authenticate with our backend
        try {
          const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/auth/google`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              access_token: account.access_token,
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
          user.backendUser = userValidation.data;
          // Store isNewUser in a way TypeScript accepts
          (user as any).__isNewUser = data.isNewUser;
          
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
          token.isNewUser = (user as any).__isNewUser;
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
    
    async redirect({ url, baseUrl }) {
      // Default redirect behavior - we'll handle new user redirects differently
      if (url.startsWith('/')) return `${baseUrl}${url}`;
      if (new URL(url).origin === baseUrl) return url;
      return baseUrl;
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