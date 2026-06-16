/**
 * The single source of truth for pinning internal cross-dependencies at publish.
 *
 * Source `package.json` files declare internal `@semiont/*` / `semiont-*`
 * dependencies as `"*"` — that links the local workspace in dev and can never
 * drift. This function is the publish-time normalization: it rewrites every
 * internal dependency (the `"*"` ranges, and anything else) to the *exact*
 * release version, so published tarballs install against the matching sibling
 * version on registries that don't honor workspace ranges.
 *
 * We publish every package at every version, so an exact pin always resolves —
 * see docs/development/RELEASE.md ("Internal dependency pinning").
 *
 * @param {object} json    a parsed package.json (mutated in place)
 * @param {string} version the exact release version, e.g. "0.5.8"
 * @returns {boolean} true if any dependency was changed
 */
export function stampInternalDeps(json, version) {
  let changed = false;
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = json[section];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      if (!(name.startsWith('@semiont/') || name.startsWith('semiont-'))) continue;
      if (deps[name] !== version) {
        deps[name] = version;
        changed = true;
      }
    }
  }
  return changed;
}
