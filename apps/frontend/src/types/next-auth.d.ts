import { DefaultSession, DefaultUser } from 'next-auth';
import type { SessionProviderProps } from 'next-auth/react';

// Fix next-auth v4 SessionProvider return type for React 19
// next-auth v4 declares `JSX.Element` which is incompatible with React 19's types
declare module 'next-auth/react' {
  export function SessionProvider(props: SessionProviderProps): React.ReactNode;
}

declare module 'next-auth' {
  interface Session extends DefaultSession {
    backendToken?: string;
    backendUser?: {
      id: string;
      email: string;
      name?: string | undefined;
      image?: string | undefined;
      domain: string;
      isAdmin: boolean;
      isModerator: boolean;
      termsAcceptedAt?: string | null;
    };
    isNewUser?: boolean;
    user?: {
      name?: string | null;
      email?: string | null;
      image?: string | null;
      isAdmin?: boolean;
    };
  }

  interface User extends DefaultUser {
    backendToken?: string;
    backendUser?: {
      id: string;
      email: string;
      name?: string | undefined;
      image?: string | undefined;
      domain: string;
      isAdmin: boolean;
      isModerator: boolean;
      termsAcceptedAt?: string | null;
    };
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    backendToken?: string;
    backendUser?: {
      id: string;
      email: string;
      name?: string | undefined;
      image?: string | undefined;
      domain: string;
      isAdmin: boolean;
      isModerator: boolean;
      termsAcceptedAt?: string | null;
    };
    isNewUser?: boolean;
  }
}