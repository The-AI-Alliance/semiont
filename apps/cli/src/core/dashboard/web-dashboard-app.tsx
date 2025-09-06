/**
 * Web Dashboard React Application
 * 
 * This is the React app for the web dashboard that reuses the same components
 * as the terminal dashboard, eliminating duplication
 */

import React, { useState, useEffect } from 'react';
import { ServiceStatus, LogEntry, MetricData } from './dashboard-components';

// Type declarations for browser globals
declare const window: any;

// Dashboard data interface (shared with terminal)
export interface DashboardData {
  services: ServiceStatus[];
  logs: LogEntry[];
  metrics: MetricData[];
  lastUpdate: Date;
  isRefreshing: boolean;
}

// Status indicator component
const StatusIndicator: React.FC<{ status: ServiceStatus['status'] }> = ({ status }) => {
  const colors = {
    healthy: '#48bb78',
    unhealthy: '#f56565',
    warning: '#ed8936',
    unknown: '#a0aec0'
  };
  
  return (
    <div 
      className={`status-indicator status-${status}`}
      style={{ background: colors[status] }}
    />
  );
};

// Service panel component
const ServicePanel: React.FC<{ 
  services: ServiceStatus[];
  title: string;
  showActions?: boolean;
}> = ({ services, title, showActions = true }) => {
  const getConsoleLinks = (service: ServiceStatus) => {
    const links: Array<{ label: string; url: string; className: string }> = [];
    const region = service.awsRegion || 'us-east-1';
    
    // ECS Service links
    if (service.ecsServiceName && service.ecsClusterName) {
      links.push({
        label: '📊 Console',
        url: `https://console.aws.amazon.com/ecs/home?region=${region}#/clusters/${service.ecsClusterName}/services/${service.ecsServiceName}/details`,
        className: 'console'
      });
      if (service.logGroupName) {
        links.push({
          label: '📝 Logs',
          url: `https://console.aws.amazon.com/cloudwatch/home?region=${region}#logsV2:log-groups/log-group/${encodeURIComponent(service.logGroupName)}`,
          className: 'logs'
        });
      }
      links.push({
        label: '📈 Metrics',
        url: `https://console.aws.amazon.com/cloudwatch/home?region=${region}#metricsV2:graph=~();query=~'*7bAWS*2fECS*2cClusterName*2cServiceName*7d*20${service.ecsClusterName}*20${service.ecsServiceName}`,
        className: 'metrics'
      });
    }
    
    // RDS Database link
    if (service.rdsInstanceId) {
      links.push({
        label: '📊 Console',
        url: `https://console.aws.amazon.com/rds/home?region=${region}#database:id=${service.rdsInstanceId};is-cluster=false`,
        className: 'console'
      });
      links.push({
        label: '📈 Metrics',
        url: `https://console.aws.amazon.com/cloudwatch/home?region=${region}#metricsV2:graph=~();query=~'*7bAWS*2fRDS*2cDBInstanceIdentifier*7d*20${service.rdsInstanceId}`,
        className: 'metrics'
      });
    }
    
    // EFS Filesystem link
    if (service.efsFileSystemId) {
      links.push({
        label: '📊 Console',
        url: `https://console.aws.amazon.com/efs/home?region=${region}#/file-systems/${service.efsFileSystemId}`,
        className: 'console'
      });
      links.push({
        label: '📈 Metrics',
        url: `https://console.aws.amazon.com/cloudwatch/home?region=${region}#metricsV2:graph=~();query=~'*7bAWS*2fEFS*2cFileSystemId*7d*20${service.efsFileSystemId}`,
        className: 'metrics'
      });
    }
    
    // Load Balancer link
    if (service.albArn) {
      const arnParts = service.albArn.split('/');
      if (arnParts.length >= 3) {
        const loadBalancerName = arnParts[arnParts.length - 2];
        links.push({
          label: '📊 Console',
          url: `https://console.aws.amazon.com/ec2/v2/home?region=${region}#LoadBalancers:search=${loadBalancerName};sort=loadBalancerName`,
          className: 'console'
        });
      }
      links.push({
        label: '📈 Metrics',
        url: `https://console.aws.amazon.com/cloudwatch/home?region=${region}#metricsV2:graph=~();query=~'*7bAWS*2fApplicationELB*2cLoadBalancer*7d`,
        className: 'metrics'
      });
    }
    
    return links;
  };

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
  };

  return (
    <div className="dashboard-panel">
      <div className="panel-title">{title}</div>
      {services.map((service, index) => (
        <div key={index} className="service-item" style={{ marginBottom: '12px' }}>
          <StatusIndicator status={service.status} />
          <div style={{ flex: 1 }}>
            <div className="service-name">
              {service.name}
              {service.revision && (
                <span style={{ color: '#00bcd4', marginLeft: '8px', fontSize: '0.9em' }}>
                  rev:{service.revision}
                </span>
              )}
              {service.runningCount !== undefined && service.desiredCount !== undefined && (
                <span style={{ color: '#999', marginLeft: '8px', fontSize: '0.9em' }}>
                  [{service.runningCount}/{service.desiredCount}]
                </span>
              )}
            </div>
            {service.details && (
              <div className="service-details">{service.details}</div>
            )}
            
            {/* EFS Storage Metrics */}
            {service.name === 'Filesystem' && service.storageTotalBytes && (
              <>
                <div className="service-details" style={{ color: '#2563eb', fontSize: '0.9em', marginTop: '8px' }}>
                  <strong>Storage:</strong>
                </div>
                {service.storageUsedBytes !== undefined && service.storageTotalBytes && (
                  <div className="service-details" style={{ color: '#718096', fontSize: '0.9em', paddingLeft: '16px' }}>
                    Used: {formatBytes(service.storageUsedBytes)} / {formatBytes(service.storageTotalBytes)}
                    {service.storageUsedPercent !== undefined && (
                      <span style={{ 
                        marginLeft: '8px',
                        color: service.storageUsedPercent > 90 ? '#ef4444' : 
                               service.storageUsedPercent > 70 ? '#f59e0b' : '#10b981'
                      }}>
                        ({service.storageUsedPercent.toFixed(1)}%)
                      </span>
                    )}
                  </div>
                )}
                {service.storageAvailableBytes !== undefined && (
                  <div className="service-details" style={{ color: '#718096', fontSize: '0.9em', paddingLeft: '16px' }}>
                    Available: {formatBytes(service.storageAvailableBytes)}
                  </div>
                )}
                {service.throughputUtilization !== undefined && (
                  <div className="service-details" style={{ color: '#718096', fontSize: '0.9em', paddingLeft: '16px' }}>
                    Throughput: {service.throughputUtilization.toFixed(1)}%
                  </div>
                )}
                {service.clientConnections !== undefined && (
                  <div className="service-details" style={{ color: '#718096', fontSize: '0.9em', paddingLeft: '16px' }}>
                    Connections: {service.clientConnections}
                  </div>
                )}
              </>
            )}
            
            {/* Regular metrics for other services */}
            {service.name !== 'Filesystem' && (service.cpuUtilization !== undefined || service.memoryUtilization !== undefined) && (
              <div className="service-details" style={{ color: '#718096', fontSize: '0.9em' }}>
                {service.cpuUtilization !== undefined && (
                  <span>CPU: {service.cpuUtilization.toFixed(1)}%</span>
                )}
                {service.cpuUtilization !== undefined && service.memoryUtilization !== undefined && (
                  <span style={{ margin: '0 8px' }}>•</span>
                )}
                {service.memoryUtilization !== undefined && (
                  <span>Memory: {service.memoryUtilization.toFixed(1)}%</span>
                )}
              </div>
            )}
            
            {service.deploymentStatus && service.deploymentStatus !== 'PRIMARY' && (
              <div className="service-details" style={{ color: '#ff9800' }}>
                Deployment: {service.deploymentStatus}
              </div>
            )}
            
            {service.loadBalancerDns && (
              <div className="service-details" style={{ color: '#00bcd4', fontSize: '0.9em' }}>
                ALB: {service.loadBalancerDns}
              </div>
            )}
            
            {service.wafWebAclId && (
              <div className="service-details" style={{ color: '#4caf50', fontSize: '0.9em' }}>
                WAF: Protected ✓
              </div>
            )}
            
            {/* Action Buttons */}
            {showActions && getConsoleLinks(service).length > 0 && (
              <div className="action-buttons">
                {getConsoleLinks(service).map((link, linkIndex) => (
                  <a 
                    key={linkIndex}
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`action-button ${link.className}`}
                  >
                    {link.label}
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
};

// Log viewer component
const LogViewer: React.FC<{ logs: LogEntry[] }> = ({ logs }) => {
  const getLevelClass = (level: string) => {
    return `log-level log-level-${level}`;
  };

  return (
    <div className="dashboard-panel logs-panel">
      <div className="panel-title">Recent Logs</div>
      {logs.length === 0 ? (
        <div style={{ padding: '20px', color: '#718096', textAlign: 'center' }}>
          No recent logs
        </div>
      ) : (
        logs.slice(0, 50).map((log, index) => (
          <div key={index} className="log-entry">
            <span className="log-timestamp">
              {new Date(log.timestamp).toLocaleTimeString()}
            </span>
            <span className="log-service">{log.service}</span>
            <span className={getLevelClass(log.level)}>
              {log.level.toUpperCase()}
            </span>
            <span className="log-message">{log.message}</span>
          </div>
        ))
      )}
    </div>
  );
};

// Main Web Dashboard Component
export const WebDashboardApp: React.FC<{
  environment: string;
  refreshInterval: number;
}> = ({ environment, refreshInterval }) => {
  const [data, setData] = useState<DashboardData | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [, setSocket] = useState<any>(null);

  useEffect(() => {
    // @ts-ignore - Socket.IO is loaded via script tag
    const io = window.io;
    if (!io) {
      console.error('Socket.IO not loaded');
      return;
    }

    const newSocket = io();
    setSocket(newSocket);
    
    newSocket.on('connect', () => {
      setConnected(true);
    });
    
    newSocket.on('disconnect', () => {
      setConnected(false);
    });
    
    newSocket.on('dashboard-update', (newData: DashboardData) => {
      setData(newData);
      setLastUpdate(new Date());
    });
    
    newSocket.on('dashboard-error', (error: any) => {
      console.error('Dashboard error:', error);
    });
    
    return () => {
      newSocket.disconnect();
    };
  }, []);

  const formatTime = (date: Date | null) => {
    if (!date) return 'Never';
    return date.toLocaleTimeString();
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

  // Split services by category
  const appServices = data.services.filter(s => 
    ['Frontend', 'Backend', 'Load Balancer', 'WAF', 'DNS (Route 53)'].includes(s.name)
  );
  const dataServices = data.services.filter(s => 
    ['Database', 'Filesystem'].includes(s.name)
  );

  return (
    <div className="dashboard-container">
      <div className="dashboard-header">
        <div>
          <div className="dashboard-title">Semiont System Dashboard</div>
          <div className="dashboard-subtitle">Environment: {environment}</div>
        </div>
        <div className="refresh-info">
          <div>Last updated: {formatTime(lastUpdate)}</div>
          <div>Auto-refresh: every {refreshInterval}s</div>
        </div>
      </div>
      
      <div className="dashboard-grid">
        <ServicePanel 
          services={appServices}
          title="App Services"
          showActions={true}
        />
        
        <ServicePanel 
          services={dataServices}
          title="Data"
          showActions={true}
        />
      </div>
      
      <LogViewer logs={data.logs} />
      
      <div className={`connection-status ${connected ? 'connected' : 'disconnected'}`}>
        {connected ? '🟢 Connected' : '🔴 Disconnected'}
      </div>
    </div>
  );
};

// Export for browser usage
if (typeof window !== 'undefined') {
  window.SemiontDashboard = window.SemiontDashboard || {};
  window.SemiontDashboard.WebDashboardApp = WebDashboardApp;
}