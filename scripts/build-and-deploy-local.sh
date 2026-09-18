#!/usr/bin/env bash
# Build the controller and worker images, push them to the local registry
# (agent-browser-registry, localhost:5000), and roll the live Helm release
# to the resulting digests. Replaces the old docker-save / k3s-ctr-import /
# imagePullPolicy=Never workflow, which was fragile (OCI tar tagging quirks)
# and vulnerable to kubelet image GC evicting an untagged/orphaned import.
#
# Prerequisites (one-time):
#   docker run -d --name agent-browser-registry --restart unless-stopped \
#     -p 5000:5000 -v agent-browser-registry-data:/var/lib/registry registry:2
#   sudo tee /etc/rancher/k3s/registries.yaml <<'YAML'
#   mirrors:
#     "localhost:5000":
#       endpoint: ["http://localhost:5000"]
#   configs:
#     "localhost:5000":
#       tls:
#         insecure_skip_verify: true
#   YAML
#   sudo systemctl restart k3s
set -euo pipefail
cd "$(dirname "$0")/.."

REGISTRY=localhost:5000
NAMESPACE=agent-browser
RELEASE=agent-browser

docker build -t "$REGISTRY/agent-browser-controller:dev" .
docker build -t "$REGISTRY/agent-browser-worker:dev" worker/

controller_digest=$(docker push "$REGISTRY/agent-browser-controller:dev" | grep -oE 'sha256:[a-f0-9]{64}')
worker_digest=$(docker push "$REGISTRY/agent-browser-worker:dev" | grep -oE 'sha256:[a-f0-9]{64}')

echo "controller digest: $controller_digest"
echo "worker digest: $worker_digest"

helm upgrade "$RELEASE" charts/agent-browser -n "$NAMESPACE" \
  --set image.repository="$REGISTRY/agent-browser-controller" \
  --set image.digest="$controller_digest" \
  --set image.pullPolicy=IfNotPresent \
  --set workerImage.repository="$REGISTRY/agent-browser-worker" \
  --set workerImage.digest="$worker_digest" \
  --set workerImage.pullPolicy=IfNotPresent \
  --set postgres.enabled=true \
  --set postgres.secretName=agent-browser-postgres

kubectl rollout status deployment/agent-browser-controller -n "$NAMESPACE"
