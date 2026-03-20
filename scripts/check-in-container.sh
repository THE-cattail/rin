#!/usr/bin/env sh
set -eu

if ! command -v docker >/dev/null 2>&1; then
  echo "rin: Docker is required for containerized checks." >&2
  exit 1
fi

docker build --progress=plain --target check -f Dockerfile.check .
