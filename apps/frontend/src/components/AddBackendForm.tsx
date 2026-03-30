import { useState } from 'react';
import { SemiontApiClient } from '@semiont/api-client';
import { baseUrl, email as makeEmail } from '@semiont/core';
import { useWorkspaceContext, Workspace } from '@/contexts/WorkspaceContext';
import { useAuthContext } from '@/contexts/AuthContext';

interface AddBackendFormProps {
  onSuccess: () => void;
}

export function AddBackendForm({ onSuccess }: AddBackendFormProps) {
  const { addWorkspace } = useWorkspaceContext();
  const { setSession } = useAuthContext();

  const [url, setUrl] = useState('');
  const [emailValue, setEmailValue] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    let normalizedUrl = url.trim();
    if (!normalizedUrl) {
      setError('Backend URL is required.');
      setIsSubmitting(false);
      return;
    }
    // Ensure scheme is present
    if (!/^https?:\/\//i.test(normalizedUrl)) {
      normalizedUrl = `https://${normalizedUrl}`;
    }

    try {
      const client = new SemiontApiClient({ baseUrl: baseUrl(normalizedUrl) });
      const response = await client.authenticatePassword(makeEmail(emailValue), password);

      const workspace: Workspace = {
        id: crypto.randomUUID(),
        label: new URL(normalizedUrl).hostname,
        backendUrl: normalizedUrl,
      };

      addWorkspace(workspace);
      setSession({ token: response.token, user: response.user as any });
      onSuccess();
    } catch {
      setError('Could not connect or authenticate. Check the URL and credentials.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-4">
      <div className="w-full max-w-md space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Connect to a backend</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Enter the URL of your Semiont backend and your credentials.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="backend-url" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Backend URL
            </label>
            <input
              id="backend-url"
              type="text"
              autoComplete="url"
              required
              placeholder="https://semiont.example.com"
              value={url}
              onChange={e => setUrl(e.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label htmlFor="backend-email" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Email
            </label>
            <input
              id="backend-email"
              type="email"
              autoComplete="email"
              required
              value={emailValue}
              onChange={e => setEmailValue(e.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label htmlFor="backend-password" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Password
            </label>
            <input
              id="backend-password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {error && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full flex justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? 'Connecting…' : 'Connect'}
          </button>
        </form>
      </div>
    </div>
  );
}
