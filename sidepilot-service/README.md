# Sidepilot Service Deployment

This Kustomize tree deploys the two apps (`sidepilot-server`, `knowledge-system`) and the CloudNativePG Postgres cluster.

Render dev locally:

```sh
kubectl kustomize ops/sidepilot-service/kustomize/overlays/dev/
```

The dev overlay is the source of truth for both application image tags. Changes under the Kustomize tree deploy automatically after they reach `main`.
