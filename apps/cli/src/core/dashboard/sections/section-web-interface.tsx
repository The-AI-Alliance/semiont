import React from 'react';
import { SectionHeader } from './section-header.js';
import type { ServiceStatus } from '../dashboard-components.js';

function indicatorClass(status: ServiceStatus['status']): string {
  switch (status) {
    case 'healthy':   return 'semiont-indicator semiont-indicator--online';
    case 'unhealthy': return 'semiont-indicator semiont-indicator--offline';
    case 'warning':   return 'semiont-indicator semiont-indicator--warning';
    default:          return 'semiont-indicator';
  }
}

const ServiceCard: React.FC<{ service: ServiceStatus }> = ({ service }) => {
  const details = service.details || '';
  // Extract port from details like "Port: 4000" or "pid: 1234"
  const portMatch = details.match(/[Pp]ort:\s*(\d+)/);
  const pidMatch = details.match(/[Pp][Ii][Dd]:\s*(\d+)/);
  const containerMatch = details.match(/[Cc]ontainer:\s*(\S+)/);
  const volumeMatch = details.match(/[Vv]olume(?:[Nn]ame)?:\s*(\S+)/);

  const primaryValue = portMatch ? `:${portMatch[1]}` :
                       containerMatch ? containerMatch[1].slice(0, 16) :
                       service.status;

  const tags: string[] = [];
  if (pidMatch) tags.push(`pid:${pidMatch[1]}`);
  if (volumeMatch) tags.push(`vol:${volumeMatch[1].slice(0, 20)}`);
  if (service.runningCount !== undefined && service.desiredCount !== undefined) {
    tags.push(`${service.runningCount}/${service.desiredCount}`);
  }

  const consoleLinks = getConsoleLinks(service);

  return (
    <div className="semiont-stat-card">
      <span className={indicatorClass(service.status)} />
      <div className="semiont-stat-card__label">{service.name}</div>
      <div className="semiont-stat-card__value">{primaryValue}</div>
      {tags.length > 0 && (
        <div className="semiont-stat-card__meta">
          {tags.map((t, i) => <span key={i} className="semiont-tag">{t}</span>)}
        </div>
      )}
      {consoleLinks.length > 0 && (
        <div className="stat-card-actions">
          {consoleLinks.map((link, i) => (
            <a key={i} href={link.url} target="_blank" rel="noopener noreferrer"
               className="semiont-button" data-variant="ghost" data-size="sm">
              {link.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
};

function getConsoleLinks(service: ServiceStatus) {
  const links: { label: string; url: string }[] = [];
  const region = service.awsRegion || 'us-east-1';
  if (service.ecsServiceName && service.ecsClusterName) {
    links.push({ label: 'Console ↗', url: `https://console.aws.amazon.com/ecs/home?region=${region}#/clusters/${service.ecsClusterName}/services/${service.ecsServiceName}/details` });
    if (service.logGroupName) {
      links.push({ label: 'Logs ↗', url: `https://console.aws.amazon.com/cloudwatch/home?region=${region}#logsV2:log-groups/log-group/${encodeURIComponent(service.logGroupName)}` });
    }
  }
  if (service.rdsInstanceId) {
    links.push({ label: 'Console ↗', url: `https://console.aws.amazon.com/rds/home?region=${region}#database:id=${service.rdsInstanceId};is-cluster=false` });
  }
  return links;
}

interface Props {
  services: ServiceStatus[];
}

export const SectionWebInterface: React.FC<Props> = ({ services }) => {
  const healthyCount = services.filter(s => s.status === 'healthy').length;

  return (
    <SectionHeader title="Web Interface" healthyCount={healthyCount} totalCount={services.length}>
      <div className="stat-card-grid">
        {services.map((s, i) => <ServiceCard key={i} service={s} />)}
      </div>
    </SectionHeader>
  );
};
