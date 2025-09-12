'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function KnowledgePage() {
  const router = useRouter();

  useEffect(() => {
    // Redirect to Discover as the default page
    router.replace('/know/search');
  }, [router]);

  return (
    <div className="flex items-center justify-center py-20">
      <p className="text-gray-600 dark:text-gray-300">Redirecting...</p>
    </div>
  );
}