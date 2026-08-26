# Frontend Deployment

How the Semiont frontend is shipped and run.

> **The CLI no longer deploys the frontend.** The `semiont publish` / `semiont update` commands and
> the AWS platform they targeted have been **removed**. The frontend ships as a published container
> image; running it anywhere beyond the supported paths below is **an exercise for the reader**.

## What ships

`ghcr.io/the-ai-alliance/semiont-frontend`, built by CI from
[apps/browser/Dockerfile](../Dockerfile) and tagged per release plus `latest`. The container serves
on **port 3000** and its entrypoint is a plain `node node_modules/@semiont/frontend/server.js` — no
CLI involved.

Image build and publication: [administration/IMAGES.md](../../../docs/system/administration/IMAGES.md).

## Running it

The frontend is a member of the KB stack, so it comes up with the stack rather than being deployed
on its own:

```bash
# Supported path 1 — the host-installed launcher, from a KB directory
semiont start
semiont stop --service frontend      # the browser is a stack-independent viewer; this closes it

# Supported path 2 — compose, using the KB's own file
docker compose -f .semiont/compose/backend.yml up
```

Pin a version with `SEMIONT_VERSION`. See [apps/launcher](../../launcher/README.md) and
[administration/DEPLOYMENT.md](../../../docs/system/administration/DEPLOYMENT.md).

## Local development

For iterating on the frontend itself, run it from source rather than the image — see
[DEVELOPMENT.md](./DEVELOPMENT.md).

## Running it elsewhere

Any container platform can schedule the image (ECS Fargate, Kubernetes, a VM with Docker). Nothing
here does it for you. Frontend-specific considerations:

- **It needs to reach the backend.** The browser app discovers KBs by host/port; the backend must be
  reachable from the *user's browser*, not merely from inside the cluster.
- **Ingress and TLS** in front of port 3000 is platform work.
- **No server-side session state** — the frontend is a static SPA served by a small Node server;
  auth is bearer-token, held in the browser. It scales horizontally without sticky sessions.

Fuller checklist: [platforms/AWS.md](../../../docs/system/platforms/AWS.md).

## Related Documentation

- [DEVELOPMENT.md](./DEVELOPMENT.md) — local development
- [administration/DEPLOYMENT.md](../../../docs/system/administration/DEPLOYMENT.md) — stack deployment
- [administration/IMAGES.md](../../../docs/system/administration/IMAGES.md) — image build/publish
- [CONTAINER-TOPOLOGY.md](../../../docs/system/CONTAINER-TOPOLOGY.md) — what runs where
