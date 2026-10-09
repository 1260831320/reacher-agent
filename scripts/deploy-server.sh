#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ -f "${PROJECT_DIR}/.deploy.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${PROJECT_DIR}/.deploy.env"
  set +a
fi

DEPLOY_HOST="${DEPLOY_HOST:?Set DEPLOY_HOST in the environment or .deploy.env}"
DEPLOY_KEY="${DEPLOY_KEY:?Set DEPLOY_KEY in the environment or .deploy.env}"
REMOTE_SOURCE_ENV="${REMOTE_SOURCE_ENV:?Set REMOTE_SOURCE_ENV in the environment or .deploy.env}"
FEISHU_RESEARCH_CHAT_ID="${FEISHU_RESEARCH_CHAT_ID:-}"
INSTALL_ROOT="${INSTALL_ROOT:?Set INSTALL_ROOT in the environment or .deploy.env}"
REMOTE_ARCHIVE="/tmp/ai-research-agent-release-$RANDOM.tar.gz"
LOCAL_ARCHIVE="$(mktemp -t ai-research-agent.XXXXXX.tar.gz)"

cleanup() {
  rm -f "${LOCAL_ARCHIVE}"
}
trap cleanup EXIT

if [[ ! "${DEPLOY_HOST}" =~ ^[a-zA-Z0-9._-]+@[a-zA-Z0-9._:-]+$ ]]; then
  echo "Invalid DEPLOY_HOST" >&2
  exit 2
fi
if [[ ! "${REMOTE_SOURCE_ENV}" =~ ^/[a-zA-Z0-9._/-]+$ || ! "${INSTALL_ROOT}" =~ ^/[a-zA-Z0-9._/-]+$ ]]; then
  echo "REMOTE_SOURCE_ENV and INSTALL_ROOT must be safe absolute paths" >&2
  exit 2
fi
if [[ -n "${FEISHU_RESEARCH_CHAT_ID}" && ! "${FEISHU_RESEARCH_CHAT_ID}" =~ ^oc_[a-zA-Z0-9]+$ ]]; then
  echo "Invalid FEISHU_RESEARCH_CHAT_ID: ${FEISHU_RESEARCH_CHAT_ID}" >&2
  exit 2
fi

cd "${PROJECT_DIR}"
npm test
if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
  echo 'Commit the release changes before deployment' >&2
  exit 1
fi
SOURCE_COMMIT="$(git rev-parse HEAD)"
# Package tracked committed files only; never copy local credentials or outputs.
git archive --format=tar.gz --output="${LOCAL_ARCHIVE}" HEAD

scp -i "${DEPLOY_KEY}" -o BatchMode=yes "${LOCAL_ARCHIVE}" "${DEPLOY_HOST}:${REMOTE_ARCHIVE}"
ssh -i "${DEPLOY_KEY}" -o BatchMode=yes "${DEPLOY_HOST}" \
  "RUN_SMOKE=${RUN_SMOKE:-1} ENABLE_CODEX_RESETS=${ENABLE_CODEX_RESETS:-0} SOURCE_COMMIT='${SOURCE_COMMIT}' INSTALL_ROOT='${INSTALL_ROOT}' SOURCE_ENV='${REMOTE_SOURCE_ENV}' FEISHU_RESEARCH_CHAT_ID='${FEISHU_RESEARCH_CHAT_ID}' bash -s -- '${REMOTE_ARCHIVE}'" \
  < "${PROJECT_DIR}/deploy/server/install-release.sh"
ssh -i "${DEPLOY_KEY}" -o BatchMode=yes "${DEPLOY_HOST}" "rm -f '${REMOTE_ARCHIVE}'"
