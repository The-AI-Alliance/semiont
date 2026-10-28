/**
 * The label a path gives: that of the one app, image, test suite, SDK or part
 * of the spec it is in. lint:labels holds .github/labels.yml to the labels the
 * repository's files give, and the Path Labels workflow adds to each pull
 * request the labels of the files it changes.
 */

import { fileURLToPath } from 'node:url';
import { repositoryFiles } from './repository-files.mjs';

/** The parts of the spec, by who honours them, each the entries of specs/src it holds. */
export const SPEC_PARTS = {
  protocol: ['openapi.json', 'components', 'paths', 'bus', 'identifiers', 'principals', 'jobs', 'media-types', 'locales'],
  sdk: ['client', 'session', 'retry', 'resources', 'errors', 'sdk-telemetry'],
  services: ['archivist', 'librarian', 'smelter', 'weaver', 'worker', 'follower', 'graph', 'vectors', 'text', 'annotations', 'service-environment', 'service-telemetry'],
  launcher: ['stack', 'kb-identity', 'discovery', 'sign-in-store'],
};

/** The apps: the directories under apps/. */
const APPS = new Set(
  repositoryFiles(fileURLToPath(new URL('../..', import.meta.url)))
    .filter((file) => file.startsWith('apps/') && file.split('/').length > 2)
    .map((file) => file.split('/')[1]),
);

/** The directory of packages/ that holds the TypeScript SDK. */
const TYPESCRIPT_SDK = 'sdk';

/**
 * The language of the SDK a path below packages/<owner>/ is in, or null. An SDK
 * in its language's directory is packages/<language>/sdk/; the others are
 * packages/sdk-<language>/.
 */
function sdkLanguage(owner, below) {
  if (owner === TYPESCRIPT_SDK) return 'typescript';
  if (owner.startsWith('sdk-')) return owner.slice('sdk-'.length);
  if (below[0] === 'sdk' && below.length > 1) return owner;
  return null;
}

/**
 * The label of what `path` is in, or null for a path in none. A path is in an
 * app, an image, a test suite or an SDK when it is below its directory
 * (apps/<x>/, images/<x>/, tests/<x>/, packages/sdk/, packages/sdk-<language>/
 * or packages/<language>/sdk/), and in a part of the spec when it is an entry of
 * specs/src or below one. An app's libraries, packages/<language>/<app>/, are in
 * the app. A directory is written with its trailing slash: it is in what
 * everything below it is in.
 */
export function pathLabel(path) {
  const [top, owner, ...below] = path.replace(/^\/+/, '').split('/');
  if (top === 'specs' && owner === 'src') {
    const part = Object.keys(SPEC_PARTS).find((name) => SPEC_PARTS[name].includes(below[0]));
    return part === undefined ? null : `spec:${part}`;
  }
  if (owner === undefined || owner === '' || below.length === 0) return null;
  if (top === 'apps') return `app:${owner}`;
  if (top === 'images') return `image:${owner}`;
  if (top === 'tests') return `tests:${owner}`;
  if (top === 'packages') {
    const language = sdkLanguage(owner, below);
    if (language !== null) return `sdk:${language}`;
    return below.length > 1 && APPS.has(below[0]) ? `app:${below[0]}` : null;
  }
  return null;
}
