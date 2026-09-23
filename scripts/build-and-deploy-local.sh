#!/usr/bin/env bash
# Build the controller and worker images, push them to the local registry
# (burrowser-registry, localhost:5000), and roll the live Helm release
# to the resulting digests. Replaces the old docker-save / k3s-ctr-import /
# imagePullPolicy=Never workflow, which was fragile (OCI tar tagging quirks)
# and vulnerable to kubelet image GC evicting an untagged/orphaned import.
#
# Prerequisites (one-time):
#   docker run -d --name burrowser-registry --restart unless-stopped \
#     -p 5000:5000 -v burrowser-registry-data:/var/lib/registry registry:2
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
#
# Extra arguments are passed straight to helm, e.g. to expose the Service through the k3s
# load balancer:  ./scripts/build-and-deploy-local.sh --set service.type=LoadBalancer
#
# BURROWSER_CHART deploys a different chart directory instead of charts/burrowser, e.g. a
# site's own fork of it that carries that site's values and extra policies.
set -euo pipefail
cd "$(dirname "$0")/.."

REGISTRY=localhost:5000
NAMESPACE=burrowser
RELEASE=burrowser
CHART=${BURROWSER_CHART:-charts/burrowser}

docker build -t "$REGISTRY/burrowser-controller:dev" .
docker build -t "$REGISTRY/burrowser-worker:dev" worker/

controller_digest=$(docker push "$REGISTRY/burrowser-controller:dev" | grep -oE 'sha256:[a-f0-9]{64}')
worker_digest=$(docker push "$REGISTRY/burrowser-worker:dev" | grep -oE 'sha256:[a-f0-9]{64}')

echo "controller digest: $controller_digest"
echo "worker digest: $worker_digest"

helm upgrade --install "$RELEASE" "$CHART" -n "$NAMESPACE" \
  --set image.repository="$REGISTRY/burrowser-controller" \
  --set image.digest="$controller_digest" \
  --set image.pullPolicy=IfNotPresent \
  --set workerImage.repository="$REGISTRY/burrowser-worker" \
  --set workerImage.digest="$worker_digest" \
  --set workerImage.pullPolicy=IfNotPresent \
  --set postgres.enabled=true \
  --set postgres.secretName=burrowser-postgres \
  "$@"

kubectl rollout status deployment/burrowser-controller -n "$NAMESPACE"
