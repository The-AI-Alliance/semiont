import { Hono } from 'hono';
import type { EnvironmentConfig } from '@semiont/core';

type Variables = { config: EnvironmentConfig };

export const rootRouter = new Hono<{ Variables: Variables }>();

rootRouter.get('/', (c) => {
  const config = c.get('config');
  const projectName = (config._metadata as any)?.projectName ?? '';
  const projectVersion = (config._metadata as any)?.projectVersion ?? '';
  const siteName = config.site?.siteName ?? '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Semiont</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500&family=Orbitron:wght@700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(0.5rem); }
      to { opacity: 1; transform: translateY(0); }
    }
    body {
      animation: fadeIn 0.4s ease-out;
      background: #ffffff;
      color: #111827;
      font-family: 'Inter', -apple-system, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 0.75rem;
    }
    h1 {
      font-family: 'Orbitron', sans-serif;
      font-size: 3rem;
      font-weight: 700;
      letter-spacing: 0.15em;
      color: #0066cc;
    }
    h2 {
      font-family: 'Inter', sans-serif;
      font-size: 0.9rem;
      font-weight: 500;
      letter-spacing: 0.3em;
      color: #6b7280;
      text-transform: uppercase;
    }
    .tagline {
      font-family: 'Inter', sans-serif;
      font-size: 0.85rem;
      font-weight: 400;
      letter-spacing: 0.2em;
      color: #9ca3af;
      text-transform: lowercase;
      font-style: italic;
    }
    hr {
      width: 4rem;
      border: none;
      border-top: 2px solid #e5e7eb;
      margin: 1rem 0;
    }
    .meta {
      font-size: 0.8rem;
      color: #9ca3af;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.25rem;
    }
    nav {
      display: flex;
      gap: 1.5rem;
      margin-top: 0.5rem;
    }
    nav a {
      color: #0066cc;
      text-decoration: none;
      font-size: 0.85rem;
      padding: 0.4rem 0.75rem;
      border: 1px solid #e5e7eb;
      border-radius: 0.375rem;
      transition: background 0.15s, border-color 0.15s;
    }
    nav a:hover {
      background: #f3f4f6;
      border-color: #0066cc;
    }
    @media (prefers-color-scheme: dark) {
      body { background: #111827; color: #f3f4f6; }
      h1 { color: #60a5fa; }
      h2 { color: #9ca3af; }
      .tagline { color: #6b7280; }
      hr { border-top-color: #374151; }
      .meta { color: #6b7280; }
      nav a { color: #60a5fa; border-color: #374151; }
      nav a:hover { background: #1f2937; border-color: #60a5fa; }
    }
  </style>
</head>
<body>
  <h1>SEMIONT</h1>
  <h2>knowledge base</h2>
  <p class="tagline">make meaning</p>
  <hr>
  <div class="meta">
    ${siteName ? `<span>${siteName}</span>` : ''}
    ${projectName ? `<span>${projectName}${projectVersion ? ' v' + projectVersion : ''}</span>` : ''}
  </div>
  <nav>
    <a href="/api/docs">API Docs</a>
    <a href="/api/health">Health</a>
  </nav>
</body>
</html>`;

  return c.html(html);
});
