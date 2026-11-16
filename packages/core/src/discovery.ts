/**
 * Browser ↔ launcher KB discovery (BROWSER-KB-DISCOVERY).
 *
 * The launcher publishes its export view at `<stateDir>/discovery/kbs.json`,
 * mounted read-only into the frontend container at `/discovery` and served
 * by the frontend image at this URL path. One TS-side name for that URL: the
 * frontend server's tests fetch this constant, so prefix/filename drift
 * between the server and consumers is a failing test — mirroring for the URL
 * what the DiscoveryDocument schema does for the payload. (The launcher's Go
 * side keeps its own constant; the plan doc is the cross-language record.)
 */
export const DISCOVERY_URL_PATH = '/discovery/kbs.json';
