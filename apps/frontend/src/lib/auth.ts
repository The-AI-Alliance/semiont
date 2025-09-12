import GoogleProvider from 'next-auth/providers/google';
import CredentialsProvider from 'next-auth/providers/credentials';
import { JWTTokenSchema, OAuthUserSchema, validateData } from '@/lib/validation';
import type { NextAuthOptions } from 'next-auth';

// Build providers array based on environment
const providers: NextAuthOptions['providers'] = [];

// Add Google provider if credentials are configured
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  providers.push(
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    })
  );
}

// Add local development provider if enabled
if (process.env.ENABLE_LOCAL_AUTH === 'true' && process.env.NODE_ENV === 'development') {
  providers.push(
    CredentialsProvider({
      name: 'Local Development',
      credentials: {
        email: { label: "Email", type: "email", placeholder: "admin@example.com" }
      },
      async authorize(credentials) {
        if (!credentials?.email) {
          return null;
        }

        // Call backend local auth endpoint
        const apiUrl = process.env.BACKEND_INTERNAL_URL || process.env.NEXT_PUBLIC_API_URL;
        if (!apiUrl) {
          throw new Error('Backend API URL is required for authentication');
        }

        try {
          const response = await fetch(`${apiUrl}/api/tokens/local`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              email: credentials.email,
            }),
          });

          if (!response.ok) {
            console.error('Local authentication failed:', await response.text());
            return null;
          }

          const data = await response.json();
          
          // Return user object with backend token
          return {
            id: data.user.id,
            email: data.user.email,
            name: data.user.name || 'Local User',
            image: data.user.image,
            backendToken: data.token,
            backendUser: data.user,
          };
        } catch (error) {
          console.error('Local authentication error:', error);
          return null;
        }
      }
    })
  );
}

export const authOptions: NextAuthOptions = {
  providers,
  callbacks: {
    async signIn({ user, account, profile }) {
      // Local development auth - already validated
      if (account?.provider === 'credentials') {
        return true;
      }
      
      if (account?.provider === 'google') {
        // Frontend domain validation for better UX (fail fast)
        // Security principle: No configured domains = reject all (closed system)
        // Force fresh read of environment variable to bypass any caching
        const allowedDomainsStr = process.env.OAUTH_ALLOWED_DOMAINS || '';
        const allowedDomains = allowedDomainsStr.split(',').map(d => d.trim()).filter(Boolean);
        
        console.log(`OAuth Debug: Raw env var = '${allowedDomainsStr}'`);
        console.log(`OAuth Debug: Parsed domains = ${JSON.stringify(allowedDomains)}`);
        
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
        
        // If no domains are configured, reject all (closed system)
        if (allowedDomains.length === 0) {
          console.log('No allowed domains configured - rejecting all logins');
          return false;
        }
        
        // Check if the domain is in the allowed list
        if (!allowedDomains.includes(emailDomain)) {
          console.log(`Rejected login from domain: ${emailDomain} (allowed: ${allowedDomains.join(', ')})`);
          return false;
        }
        
        console.log(`OAuth Debug: domain ${emailDomain} is allowed`);

        // Backend authentication for security validation and token generation
        try {
          // Use Service Connect DNS name for internal backend communication
          // In production with Service Connect: http://backend:4000
          // For local development: use BACKEND_INTERNAL_URL or fallback to public URL
          const apiUrl = process.env.BACKEND_INTERNAL_URL || 
                        (process.env.NODE_ENV === 'production' ? 'http://backend:4000' : process.env.NEXT_PUBLIC_API_URL);
          if (!apiUrl) {
            throw new Error('Backend API URL is required for authentication');
          }
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
          user.backendUser = userValidation.data;
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