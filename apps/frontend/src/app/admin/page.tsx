import { notFound } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';

export default async function AdminPage() {
  const session = await getServerSession(authOptions);
  
  // Show 404 for non-admin users or unauthenticated users
  // This hides the existence of admin routes for security
  if (!session?.user?.isAdmin) {
    notFound();
  }

  // For admin users, show a simple redirect or admin landing page
  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">Admin Dashboard</h1>
        <p className="text-gray-600">Welcome to the admin area.</p>
      </div>
    </div>
  );
}