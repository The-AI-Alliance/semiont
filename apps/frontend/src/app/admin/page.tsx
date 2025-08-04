import { redirect } from 'next/navigation';

// Redirect /admin to /admin/dashboard
export default function AdminPage() {
  redirect('/admin/dashboard');
}