/**
 * Evaluate `${VAR}` placeholders in a configuration value against the
 * environment.
 *
 * This is how an address reaches a service without code inventing an
 * environment variable: the CONFIG names the variable (e.g.
 * `servers = "${NATS_HOST}:4222"`), the launcher renders it into the
 * container, and this function resolves it at use. Absence fails loudly —
 * a manufactured value is a lie the next reader cannot detect.
 *
 * Hoisted from the graph factory's private copy when the jobs driver needed
 * the same mechanism (JOB-QUEUE-DRIVER P2): one rule, one module.
 */
export function evaluateEnvPlaceholders(value: string): string;
export function evaluateEnvPlaceholders(value: string | undefined): string | undefined;
export function evaluateEnvPlaceholders(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/\$\{([^}]+)\}/g, (match, varName: string) => {
    const envValue = process.env[varName];
    if (!envValue) {
      throw new Error(`Environment variable ${varName} is not set. Referenced in configuration as ${match}`);
    }
    return envValue;
  });
}
