import React from 'react';
import type { ServiceStatus } from '../dashboard-components.js';

const TAG = 'semiont-tag semiont-tag--secondary semiont-tag--compact';

const MAKE_MEANING_SERVICES = new Set(['graph', 'neo4j', 'janusgraph', 'neptune']);
const isInferenceService = (name: string) => name.toLowerCase().startsWith('inference.');

function formatServiceName(name: string): string {
  // "inference.anthropic" → "Inference (Anthropic)"
  const dotIdx = name.indexOf('.');
  if (dotIdx !== -1) {
    const base = name.slice(0, dotIdx);
    const qualifier = name.slice(dotIdx + 1);
    return base.charAt(0).toUpperCase() + base.slice(1) +
      ' (' + qualifier.charAt(0).toUpperCase() + qualifier.slice(1) + ')';
  }
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// Display order for web interface services
const SERVICE_ORDER = ['proxy', 'frontend', 'backend', 'database'];

function indicatorClass(status: ServiceStatus['status']): string {
  switch (status) {
    case 'healthy':   return 'semiont-indicator semiont-indicator--online';
    case 'unhealthy': return 'semiont-indicator semiont-indicator--offline';
    case 'warning':   return 'semiont-indicator semiont-indicator--busy';
    default:          return 'semiont-indicator';
  }
}

function statusLabel(status: ServiceStatus['status']): string {
  switch (status) {
    case 'healthy':   return 'healthy';
    case 'unhealthy': return 'unhealthy';
    case 'warning':   return 'warning';
    default:          return 'unknown';
  }
}

function statusBadgeClass(status: ServiceStatus['status']): string {
  switch (status) {
    case 'healthy':   return 'semiont-badge semiont-badge--success';
    case 'unhealthy': return 'semiont-badge semiont-badge--error';
    case 'warning':   return 'semiont-badge semiont-badge--warning';
    default:          return 'semiont-badge semiont-badge--info';
  }
}

const ServiceRow: React.FC<{ service: ServiceStatus }> = ({ service }) => {
  // Evidence tags: prefer structured evidence, fall back to parsing details string
  const tags: string[] = service.evidence && service.evidence.length > 0
    ? [...service.evidence]
    : (() => {
        const details = service.details || '';
        const out: string[] = [];
        const pidMatch       = details.match(/[Pp][Ii][Dd]:\s*(\d+)/);
        const containerMatch = details.match(/[Cc]ontainer:\s*(\S+)/);
        if (pidMatch) out.push(`pid ${pidMatch[1]}`);
        if (containerMatch) out.push(`container ${containerMatch[1].slice(0, 12)}`);
        if (service.runningCount !== undefined && service.desiredCount !== undefined) {
          out.push(`${service.runningCount}/${service.desiredCount} tasks`);
        }
        return out;
      })();

  if (service.checkedAt) {
    tags.push(`checked ${new Date(service.checkedAt).toLocaleTimeString()}`);
  }

  const consoleLinks = getConsoleLinks(service);

  return (
    <div className="service-row">
      <div className="service-row__indicator">
        <span className={indicatorClass(service.status)} />
      </div>
      <div className="service-row__name">{formatServiceName(service.name)}</div>
      <div className="service-row__host">
        {service.hostname
          ? <span className="service-row__hostname">{service.hostname}</span>
          : <span className="service-row__hostname service-row__hostname--dim">—</span>
        }
      </div>
      <div className="service-row__status">
        <span className={statusBadgeClass(service.status)}>
          <span className="semiont-badge__text">{statusLabel(service.status)}</span>
        </span>
      </div>
      <div className="service-row__tags">
        {tags.map((t, i) => <span key={i} className={TAG}>{t}</span>)}
      </div>
      <div className="service-row__actions">
        {consoleLinks.map((link, i) => (
          <a key={i} href={link.url} target="_blank" rel="noopener noreferrer"
             className="semiont-tag semiont-tag--info semiont-tag--compact">
            {link.label}
          </a>
        ))}
      </div>
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
  const webServices = services.filter(s => !MAKE_MEANING_SERVICES.has(s.name.toLowerCase()) && !isInferenceService(s.name));

  // Sort by preferred order, then alphabetically for anything unknown
  const sorted = [...webServices].sort((a, b) => {
    const ai = SERVICE_ORDER.indexOf(a.name.toLowerCase());
    const bi = SERVICE_ORDER.indexOf(b.name.toLowerCase());
    if (ai === -1 && bi === -1) return a.name.localeCompare(b.name);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  return (
    <div className="service-list">
      <div className="service-list__header">
        <div className="service-row__indicator" />
        <div className="service-row__name">Service</div>
        <div className="service-row__host">Address</div>
        <div className="service-row__status">Status</div>
        <div className="service-row__tags">Details</div>
        <div className="service-row__actions" />
      </div>
      {sorted.map((s, i) => <ServiceRow key={i} service={s} />)}
    </div>
  );
};
