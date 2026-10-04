# Browser Deployment

How the Semiont Browser is shipped and run.

> **No Semiont command deploys the Browser.** It ships as a published container image; running it
> anywhere beyond the supported path below is **an exercise for the reader**.

## What ships

`ghcr.io/the-ai-alliance/semiont-browser`, built by CI from
[apps/browser/Dockerfile](../Dockerfile) and tagged per release plus `latest`. The container serves
on **port 3000** and its entrypoint is a plain `node node_modules/@semiont/browser/server.js` — no
CLI involved.

Image build and publication: [administration/IMAGES.md](../../../docs/operator/administration/IMAGES.md).

## Running it

The Browser is the machine-level viewer of every KB rather than a member of any one stack: the
host-installed launcher ensures it on every start, and it outlives each stack's `stop`:

```bash
semiont start                       # from a KB directory; ensures the Browser on :3000
semiont stop --service browser      # the explicit off-switch
```

Pin a version with `SEMIONT_VERSION`. See [apps/launcher](../../launcher/README.md) and
[administration/DEPLOYMENT.md](../../../docs/operator/administration/DEPLOYMENT.md).

## Local development

For iterating on the Browser itself, run it from source rather than the image — see
[DEVELOPMENT.md](./DEVELOPMENT.md).

## Running it elsewhere

Any container platform can schedule the image (ECS Fargate, Kubernetes, a VM with Docker). Nothing
here does it for you. Browser-specific considerations:

- **It needs to reach the gateway.** The browser app discovers KBs by host/port; the gateway must be
  reachable from the *user's browser*, not merely from inside the cluster.
- **Ingress and TLS** in front of port 3000 is platform work.
- **No server-side session state** — the Browser is a static SPA served by a small Node server;
  auth is bearer-token, held in the browser. It scales horizontally without sticky sessions.

Fuller checklist: [platforms/AWS.md](../../../docs/operator/platforms/AWS.md).

## Related Documentation

- [DEVELOPMENT.md](./DEVELOPMENT.md) — local development
- [administration/DEPLOYMENT.md](../../../docs/operator/administration/DEPLOYMENT.md) — stack deployment
- [administration/IMAGES.md](../../../docs/operator/administration/IMAGES.md) — image build/publish
- [CONTAINER-TOPOLOGY.md](../../../docs/operator/CONTAINER-TOPOLOGY.md) — what runs where
