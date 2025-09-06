/**
 * Web Dashboard Server for Semiont Watch
 * 
 * Serves a React-based dashboard in the browser with real-time updates
 * Now using the unified React component bundle to eliminate duplication
 */

import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { DashboardDataSource } from '../dashboard/dashboard-data.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import { embeddedDashboardJS, embeddedDashboardCSS, dashboardAssetsEmbedded } from './embedded-assets.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Use the embedded assets if they're available
const embeddedJS = dashboardAssetsEmbedded ? embeddedDashboardJS : undefined;
const embeddedCSS = dashboardAssetsEmbedded ? embeddedDashboardCSS : undefined;


export class WebDashboardServer {
  private app: express.Application;
  private server: ReturnType<typeof createServer>;
  private io: SocketIOServer;
  protected dataSource: DashboardDataSource;
  private updateInterval: NodeJS.Timeout | null = null;
  private port: number;
  private environment: string;
  private refreshInterval: number;
  
  constructor(environment: string, port: number = 3333, refreshInterval: number = 30) {
    this.environment = environment;
    this.port = port;
    this.refreshInterval = refreshInterval;
    this.dataSource = new DashboardDataSource(environment);
    
    // Create Express app
    this.app = express();
    this.server = createServer(this.app);
    
    // Setup Socket.IO for real-time updates
    this.io = new SocketIOServer(this.server, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"]
      }
    });
    
    this.setupRoutes();
    this.setupSocketHandlers();
  }
  
  private setupRoutes(): void {
    // Check if we have embedded assets first
    const hasEmbedded = !!(embeddedJS && embeddedCSS);
    
    let bundleExists = hasEmbedded;
    
    if (hasEmbedded) {
      // Serve embedded assets
      this.app.get('/static/dashboard.js', (_req, res) => {
        res.type('application/javascript');
        res.send(embeddedJS);
      });
      
      this.app.get('/static/dashboard.css', (_req, res) => {
        res.type('text/css');
        res.send(embeddedCSS);
      });
    } else {
      // Fallback: try to find dashboard files on disk
      const possibleDirs = [
        join(__dirname, '..', '..', '..', 'dist', 'dashboard'),
        join(__dirname, 'dashboard'),
        join(__dirname, '..', 'dashboard'),
        join(process.cwd(), 'dist', 'dashboard'),
        join(process.cwd(), 'apps', 'cli', 'dist', 'dashboard'),
      ];
      
      let distDir: string | null = null;
      
      for (const dir of possibleDirs) {
        if (fs.existsSync(join(dir, 'dashboard.js'))) {
          distDir = dir;
          bundleExists = true;
          console.log(`Found dashboard bundle at: ${dir}`);
          break;
        }
      }
      
      if (bundleExists && distDir) {
        this.app.use('/static', express.static(distDir));
      }
    }
    
    // Serve the main HTML page
    this.app.get('/', (_req, res) => {
      res.send(this.getHtmlPage(bundleExists));
    });
    
    // API endpoint for initial data
    this.app.get('/api/dashboard', async (_req, res) => {
      try {
        const data = await this.dataSource.getDashboardData();
        res.json(data);
      } catch (error) {
        res.status(500).json({ error: 'Failed to fetch dashboard data' });
      }
    });
  }
  
  private setupSocketHandlers(): void {
    this.io.on('connection', (socket) => {
      console.log('Client connected to dashboard');
      
      // Send initial data
      this.sendDashboardUpdate();
      
      // Start periodic updates if not already running
      if (!this.updateInterval) {
        this.startPeriodicUpdates();
      }
      
      socket.on('disconnect', () => {
        console.log('Client disconnected from dashboard');
        
        // Stop updates if no clients connected
        if (this.io.sockets.sockets.size === 0) {
          this.stopPeriodicUpdates();
        }
      });
      
      socket.on('refresh', () => {
        this.sendDashboardUpdate();
      });
    });
  }
  
  private async sendDashboardUpdate(): Promise<void> {
    try {
      const data = await this.dataSource.getDashboardData();
      this.io.emit('dashboard-update', data);
    } catch (error) {
      console.error('Failed to send dashboard update:', error);
      this.io.emit('dashboard-error', { message: 'Failed to fetch data' });
    }
  }
  
  private startPeriodicUpdates(): void {
    this.updateInterval = setInterval(() => {
      this.sendDashboardUpdate();
    }, this.refreshInterval * 1000);
  }
  
  private stopPeriodicUpdates(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }
  
  public async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, () => {
        console.log(`\n🌐 Web dashboard running at http://localhost:${this.port}`);
        console.log(`📊 Monitoring ${this.environment} environment`);
        console.log(`🔄 Refresh interval: ${this.refreshInterval} seconds`);
        console.log(`\nPress Ctrl+C to stop\n`);
        resolve();
      });
    });
  }
  
  public stop(): void {
    this.stopPeriodicUpdates();
    this.io.close();
    this.server.close();
  }
  
  private getHtmlPage(useBundle: boolean): string {
    // If we have the React bundle, use it
    if (useBundle) {
      return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Semiont Dashboard - ${this.environment}</title>
  <script src="https://cdn.socket.io/4.5.4/socket.io.min.js"></script>
  <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <link rel="stylesheet" href="/static/dashboard.css">
</head>
<body>
  <div id="root"></div>
  <script src="/static/dashboard.js"></script>
  <script>
    // Initialize dashboard when DOM is ready
    window.addEventListener('DOMContentLoaded', () => {
      // Give the dashboard script a moment to initialize
      setTimeout(() => {
        if (window.SemiontDashboard && window.SemiontDashboard.WebDashboardApp) {
          const { WebDashboardApp } = window.SemiontDashboard;
          ReactDOM.render(
            React.createElement(WebDashboardApp, {
              environment: '${this.environment}',
              refreshInterval: ${this.refreshInterval}
            }),
            document.getElementById('root')
          );
        } else {
          document.getElementById('root').innerHTML = '<div style="padding: 20px; color: red;">Dashboard initialization failed. Please rebuild the CLI.</div>';
        }
      }, 100);
    });
  </script>
</body>
</html>`;
    }
    
    // Fallback: Inline HTML (simplified version for when bundle isn't built)
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Semiont Dashboard - ${this.environment}</title>
  <script src="https://cdn.socket.io/4.5.4/socket.io.min.js"></script>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
      margin: 0;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      background: white;
      border-radius: 12px;
      padding: 30px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    }
    .header {
      border-bottom: 2px solid #e2e8f0;
      padding-bottom: 20px;
      margin-bottom: 30px;
    }
    h1 {
      margin: 0;
      color: #2d3748;
      font-size: 28px;
    }
    .subtitle {
      color: #718096;
      margin-top: 8px;
      font-size: 16px;
    }
    .info-message {
      background: #fef5e7;
      border: 2px solid #f39c12;
      border-radius: 8px;
      padding: 20px;
      margin: 20px 0;
      color: #8b6914;
    }
    .info-message h2 {
      margin-top: 0;
      color: #f39c12;
    }
    .code {
      background: #2d3748;
      color: #48bb78;
      padding: 12px 16px;
      border-radius: 6px;
      font-family: 'Courier New', monospace;
      margin: 10px 0;
    }
    .status {
      margin-top: 30px;
      padding: 15px;
      background: #f7fafc;
      border-radius: 8px;
      color: #4a5568;
    }
    .connection-status {
      display: inline-block;
      padding: 6px 12px;
      border-radius: 20px;
      font-size: 14px;
      font-weight: 500;
      margin-left: 10px;
    }
    .connected {
      background: #48bb78;
      color: white;
    }
    .disconnected {
      background: #f56565;
      color: white;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Semiont Dashboard</h1>
      <div class="subtitle">Environment: ${this.environment}</div>
    </div>
    
    <div class="info-message">
      <h2>⚠️ Dashboard Bundle Not Built</h2>
      <p>The React dashboard bundle hasn't been compiled yet. To see the full dashboard, please run:</p>
      <div class="code">npm run build:dashboard</div>
      <p>Then refresh this page to see the complete dashboard with real-time updates.</p>
    </div>
    
    <div class="status">
      <strong>Connection Status:</strong>
      <span id="status" class="connection-status disconnected">Disconnected</span>
      <div id="data" style="margin-top: 20px;"></div>
    </div>
  </div>
  
  <script>
    const socket = io();
    const statusEl = document.getElementById('status');
    const dataEl = document.getElementById('data');
    
    socket.on('connect', () => {
      statusEl.className = 'connection-status connected';
      statusEl.textContent = 'Connected';
    });
    
    socket.on('disconnect', () => {
      statusEl.className = 'connection-status disconnected';
      statusEl.textContent = 'Disconnected';
    });
    
    socket.on('dashboard-update', (data) => {
      dataEl.innerHTML = '<p>✅ Receiving data updates. Build the dashboard bundle to see the full interface.</p>';
      console.log('Dashboard data:', data);
    });
  </script>
</body>
</html>`;
  }
}