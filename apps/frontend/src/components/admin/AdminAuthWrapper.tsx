import React from 'react';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { notFound } from 'next/navigation';

interface AdminAuthWrapperProps {
  children: React.ReactNode;
}

export async function AdminAuthWrapper({ children }: AdminAuthWrapperProps) {
  const session = await getServerSession(authOptions);
  
  // If user is not authenticated or not an admin, show 404
  if (!session?.user || !session.backendUser?.isAdmin) {
    notFound();
  }

  // User is authenticated and is an admin
  return <>{children}</>;
}