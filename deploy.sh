#!/usr/bin/env bash
# Build and run the app locally with Docker.
#
# Prerequisites:
#   1. Install Docker (https://docs.docker.com/get-docker/)
#   2. Copy .env.example to .env.local and fill in your secrets
#   3. Run this script: ./deploy.sh
#
# For Coolify (self-hosted):
#   - Point Coolify at this repository (GitHub source)
#   - Set Build Pack to "Dockerfile"
#   - Add the same environment variables from .env.example in Coolify → Environment
#   - Set APP_URL to your public domain (e.g. https://listing-writer.example.com)
#   - Deploy — Coolify builds and runs the Docker image automatically

set -euo pipefail
cd "$(dirname "$0")"

bold() { printf "\033[1m%s\033[0m\n" "$1"; }

if ! command -v docker &>/dev/null; then
  echo
  bold "Docker is not installed."
  echo "Install it from https://docs.docker.com/get-docker/ and re-run ./deploy.sh"
  exit 1
fi

if [ ! -f .env.local ]; then
  echo
  bold "No .env.local found."
  echo "Copy .env.example to .env.local and fill in your secrets first:"
  echo
  echo "    cp .env.example .env.local"
  echo
  exit 1
fi

bold "Building Docker image…"
docker compose build

bold "Starting app on http://localhost:3000 …"
docker compose up -d

echo
bold "✅ Done! Open http://localhost:3000 in your browser."
echo "   To view logs: docker compose logs -f"
echo "   To stop:      docker compose down"
