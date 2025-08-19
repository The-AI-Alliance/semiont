/**
 * Web Dashboard Server for Semiont Watch
 * 
 * Serves a React-based dashboard in the browser with real-time updates
 */

import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { DashboardDataSource } from './dashboard-data.js';
import type { DashboardData } from './dashboard-layouts.js';

export class WebDashboardServer {
  private app: express.Application;
  private server: ReturnType<typeof createServer>;
  private io: SocketIOServer;
  private dataSource: DashboardDataSource;
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
    // Serve static HTML page
    this.app.get('/', (req, res) => {
      res.send(this.getHtmlPage());
    });
    
    // API endpoint for initial data
    this.app.get('/api/dashboard', async (req, res) => {
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
  
  private getHtmlPage(): string {
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
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }
    
    .dashboard-container {
      max-width: 1400px;
      margin: 0 auto;
    }
    
    .dashboard-header {
      background: white;
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 20px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    
    .dashboard-title {
      font-size: 24px;
      font-weight: bold;
      color: #2d3748;
    }
    
    .dashboard-subtitle {
      color: #718096;
      margin-top: 4px;
    }
    
    .refresh-info {
      text-align: right;
      color: #718096;
      font-size: 14px;
    }
    
    .dashboard-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
      gap: 20px;
      margin-bottom: 20px;
    }
    
    .dashboard-panel {
      background: white;
      border-radius: 12px;
      padding: 20px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    }
    
    .panel-title {
      font-size: 18px;
      font-weight: 600;
      color: #2d3748;
      margin-bottom: 16px;
      padding-bottom: 8px;
      border-bottom: 2px solid #e2e8f0;
    }
    
    .service-item {
      display: flex;
      align-items: center;
      padding: 12px;
      margin-bottom: 8px;
      border-radius: 8px;
      background: #f7fafc;
      transition: all 0.2s;
    }
    
    .service-item:hover {
      background: #edf2f7;
      transform: translateX(4px);
    }
    
    .status-indicator {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      margin-right: 12px;
      animation: pulse 2s infinite;
    }
    
    .status-healthy {
      background: #48bb78;
    }
    
    .status-warning {
      background: #ed8936;
    }
    
    .status-unhealthy {
      background: #f56565;
    }
    
    .status-unknown {
      background: #a0aec0;
    }
    
    @keyframes pulse {
      0% {
        box-shadow: 0 0 0 0 rgba(72, 187, 120, 0.7);
      }
      70% {
        box-shadow: 0 0 0 10px rgba(72, 187, 120, 0);
      }
      100% {
        box-shadow: 0 0 0 0 rgba(72, 187, 120, 0);
      }
    }
    
    .service-name {
      font-weight: 500;
      color: #2d3748;
      flex: 1;
    }
    
    .service-status {
      color: #718096;
      font-size: 14px;
      margin-right: 8px;
    }
    
    .service-details {
      color: #a0aec0;
      font-size: 12px;
      margin-top: 4px;
    }
    
    .metric-item {
      padding: 12px;
      margin-bottom: 12px;
      background: #f7fafc;
      border-radius: 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    
    .metric-name {
      color: #718096;
      font-size: 14px;
    }
    
    .metric-value {
      font-size: 20px;
      font-weight: bold;
      color: #2d3748;
    }
    
    .metric-trend {
      margin-left: 8px;
      font-size: 16px;
    }
    
    .trend-up {
      color: #48bb78;
    }
    
    .trend-down {
      color: #f56565;
    }
    
    .trend-stable {
      color: #a0aec0;
    }
    
    .logs-panel {
      grid-column: 1 / -1;
      max-height: 400px;
      overflow-y: auto;
    }
    
    .log-entry {
      font-family: 'Courier New', monospace;
      font-size: 13px;
      padding: 8px;
      border-bottom: 1px solid #e2e8f0;
      display: flex;
      gap: 12px;
    }
    
    .log-timestamp {
      color: #718096;
      min-width: 80px;
    }
    
    .log-service {
      color: #4299e1;
      min-width: 80px;
    }
    
    .log-level {
      min-width: 50px;
      font-weight: 600;
    }
    
    .log-level-error {
      color: #f56565;
    }
    
    .log-level-warn {
      color: #ed8936;
    }
    
    .log-level-info {
      color: #4299e1;
    }
    
    .log-level-debug {
      color: #a0aec0;
    }
    
    .log-message {
      flex: 1;
      color: #2d3748;
    }
    
    .connection-status {
      position: fixed;
      bottom: 20px;
      right: 20px;
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 500;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    }
    
    .connected {
      background: #48bb78;
      color: white;
    }
    
    .disconnected {
      background: #f56565;
      color: white;
    }
    
    .loading {
      display: flex;
      justify-content: center;
      align-items: center;
      height: 200px;
      color: #718096;
    }
    
    .spinner {
      border: 3px solid #e2e8f0;
      border-top: 3px solid #4299e1;
      border-radius: 50%;
      width: 40px;
      height: 40px;
      animation: spin 1s linear infinite;
    }
    
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div id="root"></div>
  
  <script type="text/babel">
    const { useState, useEffect } = React;
    
    function Dashboard() {
      const [data, setData] = useState(null);
      const [connected, setConnected] = useState(false);
      const [lastUpdate, setLastUpdate] = useState(null);
      
      useEffect(() => {
        const socket = io();
        
        socket.on('connect', () => {
          setConnected(true);
        });
        
        socket.on('disconnect', () => {
          setConnected(false);
        });
        
        socket.on('dashboard-update', (newData) => {
          setData(newData);
          setLastUpdate(new Date());
        });
        
        socket.on('dashboard-error', (error) => {
          console.error('Dashboard error:', error);
        });
        
        return () => {
          socket.disconnect();
        };
      }, []);
      
      const formatTime = (date) => {
        if (!date) return 'Never';
        return date.toLocaleTimeString();
      };
      
      const getStatusClass = (status) => {
        return 'status-' + status;
      };
      
      const getTrendIcon = (trend) => {
        if (trend === 'up') return '↑';
        if (trend === 'down') return '↓';
        return '→';
      };
      
      const getTrendClass = (trend) => {
        return 'trend-' + trend;
      };
      
      if (!data) {
        return (
          <div className="dashboard-container">
            <div className="dashboard-panel">
              <div className="loading">
                <div className="spinner"></div>
              </div>
            </div>
          </div>
        );
      }
      
      return (
        <div className="dashboard-container">
          <div className="dashboard-header">
            <div>
              <div className="dashboard-title">Semiont System Dashboard</div>
              <div className="dashboard-subtitle">Environment: ${this.environment}</div>
            </div>
            <div className="refresh-info">
              <div>Last updated: {formatTime(lastUpdate)}</div>
              <div>Auto-refresh: every ${this.refreshInterval}s</div>
            </div>
          </div>
          
          <div className="dashboard-grid">
            <div className="dashboard-panel">
              <div className="panel-title">Services Status</div>
              {data.services.map((service, index) => (
                <div key={index} className="service-item">
                  <div className={\`status-indicator \${getStatusClass(service.status)}\`}></div>
                  <div style={{ flex: 1 }}>
                    <div className="service-name">{service.name}</div>
                    {service.details && (
                      <div className="service-details">{service.details}</div>
                    )}
                  </div>
                  <div className="service-status">{service.status}</div>
                </div>
              ))}
            </div>
            
            <div className="dashboard-panel">
              <div className="panel-title">Key Metrics</div>
              {data.metrics.map((metric, index) => (
                <div key={index} className="metric-item">
                  <div className="metric-name">{metric.name}</div>
                  <div>
                    <span className="metric-value">
                      {metric.value}{metric.unit || ''}
                    </span>
                    {metric.trend && (
                      <span className={\`metric-trend \${getTrendClass(metric.trend)}\`}>
                        {getTrendIcon(metric.trend)}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
          
          <div className="dashboard-panel logs-panel">
            <div className="panel-title">Recent Logs</div>
            {data.logs.length === 0 ? (
              <div style={{ padding: '20px', color: '#718096', textAlign: 'center' }}>
                No recent logs
              </div>
            ) : (
              data.logs.slice(0, 50).map((log, index) => (
                <div key={index} className="log-entry">
                  <span className="log-timestamp">
                    {new Date(log.timestamp).toLocaleTimeString()}
                  </span>
                  <span className="log-service">{log.service}</span>
                  <span className={\`log-level log-level-\${log.level}\`}>
                    {log.level.toUpperCase()}
                  </span>
                  <span className="log-message">{log.message}</span>
                </div>
              ))
            )}
          </div>
          
          <div className={\`connection-status \${connected ? 'connected' : 'disconnected'}\`}>
            {connected ? '🟢 Connected' : '🔴 Disconnected'}
          </div>
        </div>
      );
    }
    
    ReactDOM.render(<Dashboard />, document.getElementById('root'));
  </script>
</body>
</html>
    `;
  }
}