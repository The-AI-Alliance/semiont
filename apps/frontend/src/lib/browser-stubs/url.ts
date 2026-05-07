// Browser stub for Node's 'url' module.
// vfile imports fileURLToPath for file:// URL handling that never runs in the browser.
export function fileURLToPath(url: string): string {
  return url.replace(/^file:\/\//, '');
}

export function pathToFileURL(p: string): URL {
  return new URL(`file://${p}`);
}
