import { notFound } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import AdminSecurityClient from './client';

export default async function AdminSecurityPage() {
  const session = await getServerSession(authOptions);
  
  // Show 404 for non-admin users or unauthenticated users
  // This hides the existence of admin routes for security
  if (!session?.backendUser?.isAdmin) {
    notFound();
  }

  return <AdminSecurityClient />;
}