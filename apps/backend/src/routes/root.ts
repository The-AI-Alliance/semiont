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
    body {
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
    .meta {
      margin-top: 1.5rem;
      font-size: 0.8rem;
      color: #9ca3af;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.25rem;
    }
    a {
      color: #0066cc;
      text-decoration: none;
      font-size: 0.8rem;
    }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>SEMIONT</h1>
  <h2>knowledge base</h2>
  <div class="meta">
    ${siteName ? `<span>${siteName}</span>` : ''}
    ${projectName ? `<span>${projectName}${projectVersion ? ' v' + projectVersion : ''}</span>` : ''}
    <a href="/api/health">/api/health</a>
  </div>
</body>
</html>`;

  return c.html(html);
});
