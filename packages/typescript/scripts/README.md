# TypeScript build and publish tooling

`build-packages.js` builds npm packages in dependency order. `build.sh` installs
dependencies and builds packages and apps. `publish.sh` stamps, stages, and publishes
npm packages; its supporting modules normalize internal dependencies and stage the
Browser. `check-dist-imports.mjs` and `verify-nodenext-resolution.sh` check distributions.

`compliance/` holds shared TypeScript architecture analysis. CSS tools and Stylelint
plugins live in `packages/typescript/react-ui/scripts/`.

For the complete container-based local build, run `./images/local-build.sh` from the
repository root. See `images/LOCAL-BUILD.md` for options and usage.
