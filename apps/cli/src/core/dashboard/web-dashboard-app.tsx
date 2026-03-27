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

const DEFAULT_MAKE_MEANING: MakeMeaningStatus = {
  eventLog: { path: '' },
  contentStore: { path: '' },
  graph: { status: 'unknown' },
  materializedViews: { path: '' },
  actors: {
    gatherer: { state: 'unknown' },
    matcher:  { state: 'unknown' },
    stower:   { state: 'unknown' },
    browser:  { state: 'unknown' },
  },
};

type TabId = 'web' | 'make-meaning' | 'workers';

const LogViewer: React.FC<{ logs: LogEntry[]; service?: string }> = ({ logs, service }) => {
  const filtered = service ? logs.filter(l => l.service === service || !service) : logs;
  return (
    <div className="semiont-panel semiont-panel--bordered dashboard-logs">
      <div className="semiont-panel-header">
        <span className="semiont-panel-header__title">Recent Logs</span>
      </div>
      {filtered.length === 0 ? (
        <div className="logs-empty">No recent logs</div>
      ) : (
        <div className="logs-list">
          {filtered.slice(0, 50).map((log, i) => (
            <div key={i} className={`log-entry log-entry--${log.level}`}>
              <span className="log-timestamp">{new Date(log.timestamp).toLocaleTimeString()}</span>
              <span className="log-service">{log.service}</span>
              <span className={`log-level semiont-badge semiont-badge--${log.level === 'error' ? 'error' : log.level === 'warn' ? 'warning' : 'info'}`}>
                <span className="semiont-badge__text">{log.level.toUpperCase()}</span>
              </span>
              <span className="log-message">{log.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const TabBar: React.FC<{
  active: TabId;
  onChange: (t: TabId) => void;
  webHealthy: number; webTotal: number;
  mmHealthy: number; mmTotal: number;
  wkHealthy: number; wkTotal: number;
}> = ({ active, onChange, webHealthy, webTotal, mmHealthy, mmTotal, wkHealthy, wkTotal }) => {
  const tabs: { id: TabId; label: string; healthy: number; total: number }[] = [
    { id: 'make-meaning', label: 'Make Meaning',   healthy: mmHealthy,  total: mmTotal  },
    { id: 'workers',      label: 'Workers',        healthy: wkHealthy,  total: wkTotal  },
    { id: 'web',          label: 'Web Interface',  healthy: webHealthy, total: webTotal },
  ];

  function badgeClass(healthy: number, total: number) {
    if (total === 0) return 'semiont-badge semiont-badge--info';
    if (healthy === total) return 'semiont-badge semiont-badge--success';
    if (healthy === 0) return 'semiont-badge semiont-badge--error';
    return 'semiont-badge semiont-badge--warning';
  }

  return (
    <div className="dashboard-tabs">
      {tabs.map(tab => (
        <button
          key={tab.id}
          className={`dashboard-tab${active === tab.id ? ' dashboard-tab--active' : ''}`}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          <span className={badgeClass(tab.healthy, tab.total)}>
            <span className="semiont-badge__text">{tab.healthy}/{tab.total}</span>
          </span>
        </button>
      ))}
    </div>
  );
};

const UpdateTime: React.FC<{ time: Date | null; label: string }> = ({ time, label }) => (
  <span className="tab-update-time">
    {label}: {time ? time.toLocaleTimeString() : '—'}
  </span>
);

export const WebDashboardApp: React.FC<{
  environment: string;
  refreshInterval: number;
}> = ({ environment, refreshInterval }) => {
  const [activeTab, setActiveTab] = useState<TabId>('make-meaning');

  const [services,   setServices]   = useState<ServiceStatus[]>([]);
  const [serviceLogs, setServiceLogs] = useState<LogEntry[]>([]);
  const [servicesUpdated, setServicesUpdated] = useState<Date | null>(null);

  const [makeMeaning, setMakeMeaning] = useState<MakeMeaningStatus>(DEFAULT_MAKE_MEANING);
  const [mmUpdated,   setMmUpdated]   = useState<Date | null>(null);

  const [workers,        setWorkers]        = useState<WorkerStatus[]>([]);
  const [workersUpdated, setWorkersUpdated] = useState<Date | null>(null);

  const [connected, setConnected] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const io = window.io;
    if (!io) { console.error('Socket.IO not loaded'); return; }

    const socket = io();
    socket.on('connect',    () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    socket.on('services-update', (d: { services: ServiceStatus[]; logs: LogEntry[]; lastUpdate: Date }) => {
      setServices(d.services);
      setServiceLogs(d.logs);
      setServicesUpdated(new Date());
      setReady(true);
    });

    socket.on('make-meaning-update', (d: MakeMeaningStatus & { lastUpdate?: Date }) => {
      const { lastUpdate, ...mm } = d as any;
      setMakeMeaning(mm);
      setMmUpdated(lastUpdate ? new Date(lastUpdate) : new Date());
    });

    socket.on('actors-update', (d: { actors: MakeMeaningStatus['actors']; lastUpdate?: Date }) => {
      setMakeMeaning(prev => ({ ...prev, actors: d.actors }));
      if (d.lastUpdate) setMmUpdated(new Date(d.lastUpdate));
    });

    socket.on('workers-update', (d: { workers: WorkerStatus[]; lastUpdate?: Date }) => {
      setWorkers(d.workers);
      setWorkersUpdated(d.lastUpdate ? new Date(d.lastUpdate) : new Date());
      if (!ready) setReady(true);
    });

    return () => socket.disconnect();
  }, []);

  void refreshInterval;

  if (!ready) {
    return (
      <div className="dashboard-container">
        <div className="dashboard-loading">
          <div className="semiont-spinner" />
        </div>
      </div>
    );
  }

  // Bridge graph status from services array into makeMeaning
  const graphService = services.find((s: ServiceStatus) => s.name.toLowerCase() === 'graph');
  const mm: MakeMeaningStatus = graphService
    ? { ...makeMeaning, graph: { ...makeMeaning.graph,
        status: graphService.status === 'healthy' ? 'healthy'
              : graphService.status === 'unhealthy' ? 'unhealthy' : 'unknown',
        evidence: graphService.evidence } }
    : makeMeaning;

  const MAKE_MEANING_SERVICES = new Set(['graph', 'neo4j', 'janusgraph', 'neptune']);
  const inferenceServices = services.filter(s => s.name.toLowerCase().startsWith('inference.'));
  const webServices = services.filter(s => !MAKE_MEANING_SERVICES.has(s.name.toLowerCase()) && !s.name.toLowerCase().startsWith('inference.'));
  const webHealthy = webServices.filter(s => s.status === 'healthy').length;

  // Make Meaning healthy count (mirrors section-make-meaning countHealthy)
  const mmHealthy = [
    mm.eventLog.path,
    mm.contentStore.path,
    mm.graph.status === 'healthy',
    mm.materializedViews.path,
    mm.actors.gatherer.state !== 'error' && mm.actors.gatherer.state !== 'unknown',
    mm.actors.matcher.state  !== 'error' && mm.actors.matcher.state  !== 'unknown',
    mm.actors.stower.state   !== 'error' && mm.actors.stower.state   !== 'unknown',
    mm.actors.browser.state  !== 'error' && mm.actors.browser.state  !== 'unknown',
  ].filter(Boolean).length;

  const wkHealthy = workers.filter(w => w.state !== 'error').length;

  return (
    <div className="dashboard-container">
      <header className="dashboard-header semiont-panel semiont-panel--bordered">
        <div className="dashboard-header-left">
          <h1 className="dashboard-title">Semiont Dashboard</h1>
          <span className="semiont-badge semiont-badge--info dashboard-env">
            <span className="semiont-badge__text">{environment}</span>
          </span>
        </div>
        <div className="dashboard-header-right">
          <span className={`semiont-indicator ${connected ? 'semiont-indicator--online' : 'semiont-indicator--offline'}`} />
          <span className="dashboard-connection-label">{connected ? 'Live' : 'Disconnected'}</span>
        </div>
      </header>

      <div className="semiont-panel semiont-panel--bordered dashboard-tab-panel">
        <TabBar
          active={activeTab} onChange={setActiveTab}
          webHealthy={webHealthy} webTotal={webServices.length}
          mmHealthy={mmHealthy} mmTotal={8}
          wkHealthy={wkHealthy} wkTotal={workers.length}
        />

        <div className="tab-content">
          {activeTab === 'web' && (
            <>
              <div className="tab-meta">
                <UpdateTime time={servicesUpdated} label="updated" />
              </div>
              <SectionWebInterface services={services} />
              <LogViewer logs={serviceLogs} />
            </>
          )}

          {activeTab === 'make-meaning' && (
            <>
              <div className="tab-meta">
                <UpdateTime time={mmUpdated} label="updated" />
              </div>
              <SectionMakeMeaning makeMeaning={mm} inferenceServices={inferenceServices} />
              <LogViewer logs={[]} />
            </>
          )}

          {activeTab === 'workers' && (
            <>
              <div className="tab-meta">
                <UpdateTime time={workersUpdated} label="updated" />
              </div>
              <SectionWorkers workers={workers} inferenceServices={inferenceServices} />
              <LogViewer logs={[]} />
            </>
          )}
        </div>
      </div>
    </div>
  );
};

if (typeof window !== 'undefined') {
  window.SemiontDashboard = window.SemiontDashboard || {};
  window.SemiontDashboard.WebDashboardApp = WebDashboardApp;
}
