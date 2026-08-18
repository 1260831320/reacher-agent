#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ACTION="${1:-up}"

if [[ -f "${PROJECT_DIR}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${PROJECT_DIR}/.env"
  set +a
fi

RAG_ENV_FILE="${RAG_ENV_FILE:-}"

load_bailian_env() {
  if [[ -z "${RAG_ENV_FILE}" ]]; then
    echo "RAG_ENV_FILE must point to an untracked file containing BAILIAN_API_KEY" >&2
    exit 1
  fi
  if [[ ! -f "${RAG_ENV_FILE}" ]]; then
    echo "RAG env file not found: ${RAG_ENV_FILE}" >&2
    exit 1
  fi

  set -a
  # shellcheck disable=SC1090
  source "${RAG_ENV_FILE}"
  set +a

  if [[ -z "${BAILIAN_API_KEY:-}" ]]; then
    echo "BAILIAN_API_KEY is not configured in ${RAG_ENV_FILE}" >&2
    exit 1
  fi
}

cd "${PROJECT_DIR}"

case "${ACTION}" in
  up)
    load_bailian_env
    docker compose up -d --build
    ;;
  down)
    docker compose down
    ;;
  status)
    docker compose ps
    ;;
  logs)
    docker compose logs --tail=150 -f
    ;;
  run)
    curl --fail --silent --show-error --max-time 540 \
      -X POST http://127.0.0.1:"${RESEARCH_AGENT_PORT:-8787}"/run
    echo
    ;;
  *)
    echo "Usage: $0 {up|down|status|logs|run}" >&2
    exit 2
    ;;
esac
