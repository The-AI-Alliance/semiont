import '@fontsource/inter';
import '@fontsource/orbitron';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './i18n/config'; // initialise i18next
import './app/globals.css';
import './styles/animations.css';

// Tier 2 observability. The OTel web SDK is hefty — code-splitting via
// dynamic import keeps it out of the main bundle entirely when no
// `VITE_OTEL_OTLP_ENDPOINT` is configured at build time. Vite resolves
// `import.meta.env` to a literal at build time, so when the env is
// unset the dynamic import is unreachable and Rollup drops the whole
// observability chunk.
const otlpEndpoint = import.meta.env['VITE_OTEL_OTLP_ENDPOINT'];
if (otlpEndpoint) {
  void import('@semiont/observability/web').then(({ initObservabilityWeb }) => {
    initObservabilityWeb({ serviceName: 'semiont-frontend', otlpEndpoint });
  });
}

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
