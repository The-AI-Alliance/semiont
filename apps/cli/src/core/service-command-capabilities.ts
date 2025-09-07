/**
 * Service Command Capability System
 * 
 * Defines which commands a service can support through declarative annotations.
 * Services declare their capabilities, rather than commands deciding what works.
 */

/**
 * Well-known annotation keys for command capabilities
 */
export const COMMAND_CAPABILITY_ANNOTATIONS = {
  // Deployment and build commands
  PUBLISH: 'command/supports-publish',
  UPDATE: 'command/supports-update',
  
  // Data management commands
  BACKUP: 'command/supports-backup',
  RESTORE: 'command/supports-restore',
  
  // Execution commands
  EXEC: 'command/supports-exec',
  TEST: 'command/supports-test',
  
  // Infrastructure commands
  PROVISION: 'command/supports-provision',
  CONFIGURE: 'command/supports-configure',
  
  // Lifecycle commands (most services support these by default)
  START: 'command/supports-start',
  STOP: 'command/supports-stop',
  RESTART: 'command/supports-restart',
  CHECK: 'command/supports-check',
  WATCH: 'command/supports-watch'
} as const;

/**
 * Default command support for services
 * These commands are assumed to be supported unless explicitly disabled
 */
export const DEFAULT_SUPPORTED_COMMANDS = [
  'start',
  'stop',
  'restart',
  'check',
  'watch',
  'provision',
  'configure'
] as const;

/**
 * Extract command capabilities from service annotations
 */
export function extractCommandCapabilities(
  annotations?: Record<string, string>
): Set<string> {
  const supported = new Set<string>();
  
  // Start with defaults
  for (const cmd of DEFAULT_SUPPORTED_COMMANDS) {
    const key = `command/supports-${cmd}`;
    // Add to supported unless explicitly disabled
    if (annotations?.[key] !== 'false') {
      supported.add(cmd);
    }
  }
  
  // Check all explicit annotations
  if (annotations) {
    for (const [key, value] of Object.entries(annotations)) {
      if (key.startsWith('command/supports-')) {
        const command = key.replace('command/supports-', '');
        if (value === 'true') {
          supported.add(command);
        } else if (value === 'false') {
          supported.delete(command);
        }
      }
    }
  }
  
  return supported;
}

/**
 * Check if a service supports a specific command
 */
export function serviceSupportsCommand(
  annotations: Record<string, string> | undefined,
  command: string
): boolean {
  const capabilities = extractCommandCapabilities(annotations);
  return capabilities.has(command);
}

/**
 * Helper to create command capability annotations
 */
export function createCommandCapabilities(
  capabilities: Partial<Record<keyof typeof COMMAND_CAPABILITY_ANNOTATIONS, boolean>>
): Record<string, string> {
  const annotations: Record<string, string> = {};
  
  for (const [key, value] of Object.entries(capabilities)) {
    const annotationKey = COMMAND_CAPABILITY_ANNOTATIONS[key as keyof typeof COMMAND_CAPABILITY_ANNOTATIONS];
    if (annotationKey && value !== undefined) {
      annotations[annotationKey] = String(value);
    }
  }
  
  return annotations;
}