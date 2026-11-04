/** Temporary snapshot parsed from the launcher's human-readable status report. */
export type TelemetryServiceState = 'running' | 'unhealthy' | 'stopped' | 'unknown';

export interface TelemetryService {
  url: string;
  state: TelemetryServiceState;
}

export interface TelemetryLinks {
  collector: TelemetryService;
  traces: TelemetryService;
  metrics: TelemetryService;
}

export const DEFAULT_TELEMETRY_LINKS: TelemetryLinks = {
  collector: { url: 'http://localhost:24110/metrics', state: 'unknown' },
  traces: { url: 'http://localhost:16686', state: 'unknown' },
  metrics: { url: 'http://localhost:9090', state: 'unknown' },
};

/**
 * Read the endpoints from `semiont status`. The collector's readout may be
 * published on the Apple Container host-bridge address, while the Jaeger and
 * Prometheus UIs are published on localhost. Using the launcher's reported
 * probes keeps the links aligned with the selected runtime and current stack.
 */
export function telemetryLinksFromStatus(output: string): TelemetryLinks {
  const links: TelemetryLinks = {
    collector: { ...DEFAULT_TELEMETRY_LINKS.collector },
    traces: { ...DEFAULT_TELEMETRY_LINKS.traces },
    metrics: { ...DEFAULT_TELEMETRY_LINKS.metrics },
  };
  const plain = output.replace(/\u001b\[[0-9;]*m/g, '');
  for (const line of plain.split(/\r?\n/)) {
    const row = line.match(/^\s*(collector|traces|metrics)(?:\s+\([^)]*\))?\s+(.*)$/i);
    const service = row?.[1]?.toLowerCase() as keyof TelemetryLinks | undefined;
    if (!service) continue;
    const url = line.match(/https?:\/\/[^\s]+/)?.[0];
    const details = row?.[2] ?? '';
    const stateWord = details.match(/\b(running|exited|absent|reachable|unreachable)\b/i)?.[1]?.toLowerCase();
    const state: TelemetryServiceState = stateWord === 'running'
      ? (/✗/.test(details.slice(0, details.indexOf(stateWord))) ? 'unhealthy' : 'running')
      : stateWord === 'reachable'
        ? 'running'
        : stateWord === 'exited' || stateWord === 'absent'
          ? 'stopped'
          : stateWord === 'unreachable'
            ? 'unhealthy'
            : 'unknown';

    if (url) {
      let endpoint = url.replace(/[),.;]+$/, '');
      // The launcher's status row exposes Prometheus's health probe. Link to
      // the UI root instead; keep the parsed health state separately.
      if (service === 'metrics') {
        try {
          const parsed = new URL(endpoint);
          if (parsed.pathname === '/-/healthy') parsed.pathname = '/';
          endpoint = parsed.toString();
        } catch {
          // Leave an unexpected endpoint intact for diagnostics.
        }
      }
      links[service].url = endpoint;
    }
    links[service].state = state;
  }
  return links;
}
