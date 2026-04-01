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
  <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0a0a0f;
      color: #e0e0e0;
      font-family: 'Orbitron', sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 1rem;
    }
    h1 {
      font-size: 4rem;
      font-weight: 700;
      letter-spacing: 0.2em;
      color: #00e5ff;
      text-transform: uppercase;
    }
    h2 {
      font-size: 1.2rem;
      font-weight: 400;
      letter-spacing: 0.4em;
      color: #888;
      text-transform: uppercase;
    }
    .meta {
      margin-top: 2rem;
      font-size: 0.75rem;
      letter-spacing: 0.15em;
      color: #555;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.3rem;
    }
    a {
      color: #00e5ff;
      text-decoration: none;
      letter-spacing: 0.15em;
      font-size: 0.75rem;
    }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>SEMIONT</h1>
  <h2>knowledge base</h2>
  <div class="meta">
    ${siteName ? `<span>${siteName}</span>` : ''}
    ${projectName ? `<span>project: ${projectName}${projectVersion ? ' v' + projectVersion : ''}</span>` : ''}
    <a href="/api/health">/api/health</a>
  </div>
</body>
</html>`;

  return c.html(html);
});
