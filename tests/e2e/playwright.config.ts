import { defineConfig, devices } from '@playwright/test';

/**
 * Read required env vars early and fail fast with a clear message.
 * Tests don't run without these — automating test-user creation is a
 * separate plan; for now the test runner expects the user to bring up
 * a backend with a known user.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    // eslint-disable-next-line no-console
    console.error(
      `\n[e2e] Missing required env var: ${name}\n` +
      `      Export it before running, e.g.:\n` +
      `        export ${name}=...\n` +
      `      See tests/e2e/README.md for the full list.\n`,
    );
    process.exit(1);
  }
  return value;
}

// Frontend the tests drive. Default matches the local container exposure.
export const FRONTEND_URL = process.env.E2E_FRONTEND_URL ?? 'http://localhost:3000';

// Backend the frontend points at. Separate from FRONTEND_URL because the
// sign-in form asks for host/port/protocol explicitly.
export const BACKEND_URL = process.env.E2E_BACKEND_URL ?? 'http://localhost:4000';

// Credentials for the sign-in flow. Required — no defaults so tests can't
// accidentally hit a shared account.
export const E2E_EMAIL = requireEnv('E2E_EMAIL');
export const E2E_PASSWORD = requireEnv('E2E_PASSWORD');

export default defineConfig({
  testDir: './specs',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,  // Single worker until tests + fixtures are isolated.
  workers: 1,
  retries: 0,            // Flakes should be diagnosed, not retried away.
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: FRONTEND_URL,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
