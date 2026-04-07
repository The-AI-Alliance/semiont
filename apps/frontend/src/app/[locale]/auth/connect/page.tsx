import { useEffect } from 'react';
import { useRouter } from '@/i18n/routing';

/**
 * Legacy connect page — redirects to /know/discover.
 * Authentication is now handled inline in the Knowledge Base Panel.
 */
export default function ConnectPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/know/discover');
  }, [router]);

  return null;
}
