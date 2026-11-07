/** Package manifests recognized by the workflow and coverage censuses. */
const names = new Set(['package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod', 'build.gradle.kts', 'Package.swift']);

export function isPackageManifest(name) {
  return names.has(name) || name.endsWith('.slnx') || name.endsWith('.cabal');
}
