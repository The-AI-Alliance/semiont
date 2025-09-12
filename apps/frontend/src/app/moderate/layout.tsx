import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Moderation Dashboard',
  description: 'Content governance and tag management',
};

export default function ModerateLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="container mx-auto max-w-7xl">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
          Moderation Dashboard
        </h1>
        <p className="mt-2 text-gray-600 dark:text-gray-300">
          Manage content tags and governance settings
        </p>
      </div>
      {children}
    </div>
  );
}