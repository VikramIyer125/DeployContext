# Fixer sandbox image (Tier 2). The container is started with network, used
# for `npm install`, then disconnected (`docker network disconnect`) before
# the agent phase — see src/fixer/workspace.ts.
#
# The default image is node:22 (which already includes git). Build this one
# for a slimmer footprint:
#   docker build -t deploycontext-fixer -f docker/fixer.Dockerfile .
#   DOCKER_FIXER_IMAGE=deploycontext-fixer npm start
FROM node:22-slim

# git: the wrapper's verification (status/stash/diff) runs inside the container.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
