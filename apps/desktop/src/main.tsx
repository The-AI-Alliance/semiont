import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { setPdfWorkerSrc } from '@semiont/react-ui';
import pdfWorkerCode from 'pdfjs-dist/build/pdf.worker.min.mjs?raw';
import { App } from './App';
import { AppProviders } from './providers';
import { installErrorLog } from './lib/error-log';
import { installPdfjsPolyfills } from './lib/pdfjs-polyfills';
import '@semiont/react-ui/styles/index.css';
import './index.css';

// Capture renderer errors to the XDG log.txt (Electron) so packaged-app failures are
// diagnosable without devtools. Install first, so it catches anything below.
installErrorLog();

// pdf.js 6 calls recent TC39 methods (Uint8Array hex/base64, Map.getOrInsert*, Promise.try).
// A modern Chromium has them; the polyfill is a no-op there but keeps the web build / any
// lagging runtime working. Patch the renderer, and — since the pdf.js worker runs in its own
// global — build the worker from a blob with the SAME patch prepended (the worker bundle is
// self-contained, so this is a valid module). setPdfWorkerSrc must run before any PDF opens.
installPdfjsPolyfills();
const pdfWorkerBlob = new Blob([`(${installPdfjsPolyfills.toString()})();\n`, pdfWorkerCode], {
  type: 'text/javascript',
});
setPdfWorkerSrc(URL.createObjectURL(pdfWorkerBlob));

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing from index.html');

createRoot(root).render(
  <StrictMode>
    <AppProviders>
      <App />
    </AppProviders>
  </StrictMode>,
);
