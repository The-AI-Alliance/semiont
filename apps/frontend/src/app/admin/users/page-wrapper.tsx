import { notFound } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import AdminUsersClient from './page';

export default async function AdminUsersPage() {
  const session = await getServerSession(authOptions);
  
  // Show 404 for non-admin users or unauthenticated users
  // This hides the existence of admin routes for security
  if (!session?.user?.isAdmin) {
    notFound();
  }

  return <AdminUsersClient />;
}