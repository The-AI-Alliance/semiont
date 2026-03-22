/**
 * Web Dashboard React Application
 */

import '@semiont/react-ui/styles/index.css';
import React, { useState, useEffect } from 'react';
import type { ServiceStatus, LogEntry, MakeMeaningStatus, WorkerStatus } from './dashboard-components.js';
import { SectionWebInterface } from './sections/section-web-interface.js';
import { SectionMakeMeaning } from './sections/section-make-meaning.js';
import { SectionWorkers } from './sections/section-workers.js';

declare const window: any;

export interface DashboardData {
  services: ServiceStatus[];
  logs: LogEntry[];
  metrics: unknown[];
  lastUpdate: Date;
  isRefreshing: boolean;
  makeMeaning: MakeMeaningStatus;
  workers: WorkerStatus[];
}

const DEFAULT_MAKE_MEANING: MakeMeaningStatus = {
  eventLog: { path: '' },
  contentStore: { path: '' },
  graph: { status: 'unknown' },
  materializedViews: { path: '' },
  actors: {
    gatherer: { state: 'unknown' },
    matcher:  { state: 'unknown' },
    stower:   { state: 'unknown' },
  },
};

const LogViewer: React.FC<{ logs: LogEntry[] }> = ({ logs }) => (
  <div className="semiont-panel semiont-panel--bordered dashboard-logs">
    <div className="semiont-panel-header">
      <span className="semiont-panel-header__title">Recent Logs</span>
    </div>
    {logs.length === 0 ? (
      <div className="logs-empty">No recent logs</div>
    ) : (
      <div className="logs-list">
        {logs.slice(0, 50).map((log, i) => (
          <div key={i} className={`log-entry log-entry--${log.level}`}>
            <span className="log-timestamp">{new Date(log.timestamp).toLocaleTimeString()}</span>
            <span className="log-service">{log.service}</span>
            <span className={`log-level semiont-badge semiont-badge--${log.level === 'error' ? 'error' : log.level === 'warn' ? 'warning' : 'info'}`}>
              {log.level.toUpperCase()}
            </span>
            <span className="log-message">{log.message}</span>
          </div>
        ))}
      </div>
    )}
  </div>
);

export const WebDashboardApp: React.FC<{
  environment: string;
  refreshInterval: number;
}> = ({ environment, refreshInterval }) => {
  const [data, setData] = useState<DashboardData | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  useEffect(() => {
    const io = window.io;
    if (!io) { console.error('Socket.IO not loaded'); return; }

    const socket = io();
    socket.on('connect',    () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('dashboard-update', (newData: DashboardData) => {
      setData(newData);
      setLastUpdate(new Date());
    });
    socket.on('dashboard-error', (err: any) => console.error('Dashboard error:', err));
    return () => socket.disconnect();
  }, []);

  if (!data) {
    return (
      <div className="dashboard-container">
        <div className="dashboard-loading">
          <div className="semiont-spinner" />
        </div>
      </div>
    );
  }

  const mm = data.makeMeaning ?? DEFAULT_MAKE_MEANING;

  // Populate graph status from services array if graph service was checked
  const graphService = data.services.find(s => s.name.toLowerCase() === 'graph');
  if (graphService) {
    mm.graph.status = graphService.status === 'healthy' ? 'healthy' :
                      graphService.status === 'unhealthy' ? 'unhealthy' : 'unknown';
  }

  // refreshInterval consumed by parent — suppress unused warning
  void refreshInterval;

  return (
    <div className="dashboard-container">
      <header className="dashboard-header semiont-panel semiont-panel--bordered">
        <div className="dashboard-header-left">
          <h1 className="dashboard-title">Semiont Dashboard</h1>
          <span className="semiont-badge semiont-badge--info dashboard-env">{environment}</span>
        </div>
        <div className="dashboard-header-right">
          <span className="dashboard-updated">
            updated {lastUpdate ? lastUpdate.toLocaleTimeString() : '—'}
          </span>
          <span className={`semiont-indicator ${connected ? 'semiont-indicator--online' : 'semiont-indicator--offline'}`} />
          <span className="dashboard-connection-label">{connected ? 'Live' : 'Disconnected'}</span>
        </div>
      </header>

      <SectionWebInterface services={data.services} />
      <SectionMakeMeaning makeMeaning={mm} />
      <SectionWorkers workers={data.workers ?? []} />
      <LogViewer logs={data.logs} />
    </div>
  );
};

if (typeof window !== 'undefined') {
  window.SemiontDashboard = window.SemiontDashboard || {};
  window.SemiontDashboard.WebDashboardApp = WebDashboardApp;
}
