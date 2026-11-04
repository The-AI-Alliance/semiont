import type { LauncherStatusResult } from './launcher-bridge';

export type ContainerRuntime = 'container' | 'docker' | 'podman';

export interface RuntimeUse {
  runtime: ContainerRuntime;
  runningServices: number;
}

export interface RuntimeInfo {
  active: RuntimeUse[];
  detected: ContainerRuntime[];
  statusAvailable: boolean;
}

export const RUNTIME_INSTALL_LINKS: Record<ContainerRuntime, { label: string; url: string; detail: string }> = {
  container: {
    label: 'Apple Container',
    url: 'https://github.com/apple/container',
    detail: 'macOS 26 or later, Apple silicon',
  },
  docker: {
    label: 'Docker Desktop',
    url: 'https://docs.docker.com/desktop/setup/install/mac-install/',
    detail: 'Official Mac installer',
  },
  podman: {
    label: 'Podman',
    url: 'https://podman.io/docs/installation',
    detail: 'Official installation guide',
  },
};

const runtimeLabel: Record<ContainerRuntime, string> = {
  container: 'Apple Container',
  docker: 'Docker',
  podman: 'Podman',
};

function plainOutput(output: string): string {
  return output.replace(/\u001b\[[0-9;]*m/g, '');
}

function detectedRuntimes(aboutOutput: string): ContainerRuntime[] {
  const row = plainOutput(aboutOutput).split(/\r?\n/).find((line) => /^\s*Runtimes\s+/i.test(line));
  if (!row || /none found/i.test(row)) return [];
  const value = row.replace(/^\s*Runtimes\s+/i, '').replace(/\s+\(detected on PATH\).*$/i, '');
  return value.split(',').map((part) => part.trim()).filter((part): part is ContainerRuntime =>
    part === 'container' || part === 'docker' || part === 'podman');
}

function activeRuntimes(statusOutput: string): RuntimeUse[] {
  const counts = new Map<ContainerRuntime, number>();
  for (const line of plainOutput(statusOutput).split(/\r?\n/)) {
    // Temporary parser for the status table's fixed service/runtime columns.
    const row = line.match(/^\s{2}[\w-]+(?:\s+\([^)]+\))?\s+(container|docker|podman)\s+[✓✗]\s+running\b/i);
    const runtime = row?.[1]?.toLowerCase() as ContainerRuntime | undefined;
    if (runtime) counts.set(runtime, (counts.get(runtime) ?? 0) + 1);
  }
  return [...counts].map(([runtime, runningServices]) => ({ runtime, runningServices }));
}

/** Temporary launcher-output bridge until the versioned machine API exists. */
export function runtimeInfoFromLauncher(status: LauncherStatusResult, about: LauncherStatusResult): RuntimeInfo {
  return {
    active: activeRuntimes(status.output),
    detected: detectedRuntimes(about.output),
    statusAvailable: status.exitCode === 0,
  };
}

export function runtimeName(runtime: ContainerRuntime): string {
  return runtimeLabel[runtime];
}
