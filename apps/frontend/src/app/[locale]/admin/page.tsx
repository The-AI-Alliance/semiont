import { redirect } from 'next/navigation';

export default function AdminPage() {
  // Middleware has already verified admin access
  // Just redirect to the default admin page
  redirect('/admin/users');
}