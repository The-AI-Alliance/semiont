import { notFound } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import Link from 'next/link';
import { 
  UsersIcon, 
  ShieldCheckIcon,
  ChartBarIcon,
  ServerIcon,
  CommandLineIcon,
  ArrowRightIcon
} from '@heroicons/react/24/outline';

export default async function AdminPage() {
  const session = await getServerSession(authOptions);
  
  // Show 404 for non-admin users or unauthenticated users
  // This hides the existence of admin routes for security
  if (!session?.backendUser?.isAdmin) {
    notFound();
  }

  const quickLinks = [
    {
      title: 'User Management',
      description: 'View and manage user accounts, permissions, and access levels',
      href: '/admin/users',
      icon: UsersIcon,
      color: 'blue'
    },
    {
      title: 'OAuth Configuration',
      description: 'View OAuth providers and allowed email domains',
      href: '/admin/security',
      icon: ShieldCheckIcon,
      color: 'green'
    },
  ];

  const suggestedFeatures = [
    {
      title: 'System Monitoring',
      description: 'Real-time service health, metrics, and logs',
      icon: ChartBarIcon,
      available: 'CLI: semiont check'
    },
    {
      title: 'Service Management',
      description: 'Start, stop, and restart services',
      icon: ServerIcon,
      available: 'CLI: semiont start/stop/restart'
    },
    {
      title: 'Deployment Control',
      description: 'Deploy updates and manage configurations',
      icon: CommandLineIcon,
      available: 'CLI: semiont update'
    },
  ];

  return (
    <div className="max-w-7xl mx-auto">
      {/* Welcome Section */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Admin Dashboard</h1>
        <p className="mt-2 text-gray-600 dark:text-gray-400">
          Welcome back, {session.user?.name || session.user?.email}
        </p>
      </div>

      {/* Quick Actions */}
      <div className="mb-8">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">Quick Actions</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {quickLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="group relative rounded-lg p-6 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 shadow border border-gray-200 dark:border-gray-700 transition-all"
            >
              <div className="flex items-start">
                <div className={`
                  flex items-center justify-center w-12 h-12 rounded-lg
                  ${link.color === 'blue' ? 'bg-blue-100 dark:bg-blue-900/20' : ''}
                  ${link.color === 'green' ? 'bg-green-100 dark:bg-green-900/20' : ''}
                `}>
                  <link.icon className={`
                    w-6 h-6
                    ${link.color === 'blue' ? 'text-blue-600 dark:text-blue-400' : ''}
                    ${link.color === 'green' ? 'text-green-600 dark:text-green-400' : ''}
                  `} />
                </div>
                <div className="ml-4 flex-1">
                  <h3 className="text-lg font-medium text-gray-900 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400">
                    {link.title}
                  </h3>
                  <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                    {link.description}
                  </p>
                </div>
                <ArrowRightIcon className="w-5 h-5 text-gray-400 group-hover:text-gray-600 dark:group-hover:text-gray-300 transition-colors" />
              </div>
            </Link>
          ))}
        </div>
      </div>

      {/* Suggested Features */}
      <div className="mb-8">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">DevOps Features</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          These operations are available through the Semiont CLI for enhanced control and automation.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {suggestedFeatures.map((feature) => (
            <div
              key={feature.title}
              className="rounded-lg p-6 bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700"
            >
              <div className="flex items-start">
                <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-gray-200 dark:bg-gray-700">
                  <feature.icon className="w-5 h-5 text-gray-600 dark:text-gray-400" />
                </div>
                <div className="ml-3 flex-1">
                  <h3 className="text-sm font-medium text-gray-900 dark:text-white">
                    {feature.title}
                  </h3>
                  <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                    {feature.description}
                  </p>
                  <p className="mt-2 text-xs font-mono text-blue-600 dark:text-blue-400">
                    {feature.available}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Info Box */}
      <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4 border border-blue-200 dark:border-blue-800">
        <div className="flex">
          <div className="flex-shrink-0">
            <CommandLineIcon className="h-5 w-5 text-blue-600 dark:text-blue-400" />
          </div>
          <div className="ml-3">
            <h3 className="text-sm font-medium text-blue-800 dark:text-blue-300">
              Semiont CLI for Advanced Operations
            </h3>
            <div className="mt-2 text-xs text-blue-700 dark:text-blue-400">
              <p>
                For infrastructure management, deployments, and monitoring, use the Semiont CLI:
              </p>
              <code className="block mt-2 p-2 bg-blue-100 dark:bg-blue-800/50 rounded">
                semiont --help
              </code>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}