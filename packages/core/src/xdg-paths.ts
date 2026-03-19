import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export function getStateDir(projectName: string): string {
  const xdgState = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(xdgState, 'semiont', projectName);
}

export function readProjectName(projectRoot: string): string {
  const configPath = path.join(projectRoot, '.semiont', 'config');
  if (fs.existsSync(configPath)) {
    const content = fs.readFileSync(configPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('name') && trimmed.includes('=')) {
        const [, ...rest] = trimmed.split('=');
        return rest.join('=').trim().replace(/^"(.*)"$/, '$1');
      }
    }
  }
  return path.basename(projectRoot);
}
