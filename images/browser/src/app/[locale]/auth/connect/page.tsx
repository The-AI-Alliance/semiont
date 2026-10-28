import { useEffect } from 'react';
import { useRouter } from '@/i18n/routing';

/**
 * The connect route redirects to /know/discover: authentication is handled
 * inline in the Knowledge Base Panel.
 */
export default function ConnectPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/know/discover');
  }, [router]);

  return null;
}
