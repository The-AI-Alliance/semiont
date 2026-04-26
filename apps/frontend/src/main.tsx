import '@fontsource/inter';
import '@fontsource/orbitron';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { initObservabilityWeb } from '@semiont/observability/web';
import App from './App';
import './i18n/config'; // initialise i18next
import './app/globals.css';
import './styles/animations.css';

// Tier 2 observability. No-op unless `VITE_OTEL_OTLP_ENDPOINT` is set
// at build time. Operators point this at their own collector.
const otlpEndpoint = import.meta.env['VITE_OTEL_OTLP_ENDPOINT'];
if (otlpEndpoint) {
  initObservabilityWeb({ serviceName: 'semiont-frontend', otlpEndpoint });
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
