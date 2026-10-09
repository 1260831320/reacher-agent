#!/usr/bin/env bash
set -euo pipefail

ARCHIVE_PATH="${1:?Usage: install-release.sh <release-archive>}"
INSTALL_ROOT="${INSTALL_ROOT:?INSTALL_ROOT must be an absolute server path}"
SOURCE_ENV="${SOURCE_ENV:?SOURCE_ENV must point to the private server environment file}"
RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)"
if [[ -n "${SOURCE_COMMIT:-}" ]]; then
  [[ "${SOURCE_COMMIT}" =~ ^[a-f0-9]{40}$ ]] || exit 2
  RELEASE_ID="${RELEASE_ID}-${SOURCE_COMMIT:0:8}"
fi
RELEASE_DIR="${INSTALL_ROOT}/releases/${RELEASE_ID}"
CURRENT_LINK="${INSTALL_ROOT}/current"
SHARED_DIR="${INSTALL_ROOT}/shared"
ENV_FILE="${SHARED_DIR}/app.env"
PREVIOUS_TARGET=""
LAST_GOOD_FILE="${SHARED_DIR}/last-good-release"

if [[ -f "${LAST_GOOD_FILE}" ]]; then
  PREVIOUS_TARGET="$(<"${LAST_GOOD_FILE}")"
  if [[ ! -d "${INSTALL_ROOT}/${PREVIOUS_TARGET}" ]]; then
    PREVIOUS_TARGET=""
  fi
fi

mkdir -p "${RELEASE_DIR}" "${SHARED_DIR}"
tar -xzf "${ARCHIVE_PATH}" -C "${RELEASE_DIR}"
printf '%s\n' "${SOURCE_COMMIT:-unknown}" > "${RELEASE_DIR}/source-commit"

if [[ ! -f "${ENV_FILE}" ]]; then
  if [[ ! -f "${SOURCE_ENV}" ]]; then
    echo "Existing RAG environment not found: ${SOURCE_ENV}" >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1090
  source "${SOURCE_ENV}"
  set +a
  if [[ -z "${BAILIAN_API_KEY:-}" ]]; then
    echo "BAILIAN_API_KEY is missing from ${SOURCE_ENV}" >&2
    exit 1
  fi
  umask 077
  POSTGRES_PASSWORD="$(openssl rand -hex 32)"
  N8N_ENCRYPTION_KEY="$(openssl rand -hex 32)"
  {
    printf 'BAILIAN_API_KEY=%s\n' "${BAILIAN_API_KEY}"
    printf 'BAILIAN_API_URL=%s\n' 'https://dashscope-us.aliyuncs.com/apps/anthropic/v1/messages'
    printf 'BAILIAN_PROTOCOL=%s\n' 'anthropic'
    printf 'BAILIAN_MODEL=%s\n' 'qwen3.8-max'
    printf 'POSTGRES_DB=%s\n' 'ai_research'
    printf 'POSTGRES_USER=%s\n' 'research_agent'
    printf 'POSTGRES_PASSWORD=%s\n' "${POSTGRES_PASSWORD}"
    printf 'N8N_ENCRYPTION_KEY=%s\n' "${N8N_ENCRYPTION_KEY}"
    printf 'ARXIV_MAX_RESULTS=%s\n' '100'
    printf 'ARXIV_LOOKBACK_DAYS=%s\n' '4'
    printf 'SHORTLIST_SIZE=%s\n' '12'
    printf 'DAILY_TOP_COUNT=%s\n' '5'
    printf 'PDF_EVIDENCE_COUNT=%s\n' '3'
    printf 'PDF_MAX_BYTES=%s\n' '25000000'
    printf 'PDF_MAX_CHARS=%s\n' '55000'
    printf 'EXTERNAL_SOURCE_TIMEOUT_MS=%s\n' '12000'
    printf 'HF_TOKEN=%s\n' ''
    printf 'GITHUB_TOKEN=%s\n' ''
    printf 'RESEARCH_AGENT_PORT=%s\n' '8787'
    printf 'N8N_PORT=%s\n' '5678'
    printf 'TZ=%s\n' 'Asia/Tokyo'
  } > "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
fi

ENV_BACKUP="${SHARED_DIR}/app.env.before-${RELEASE_ID}"
cp -p "${ENV_FILE}" "${ENV_BACKUP}"

rollback() {
  trap - ERR
  cp -p "${ENV_BACKUP}" "${ENV_FILE}"
  if [[ -n "${PREVIOUS_TARGET}" ]]; then
    ln -sfn "${PREVIOUS_TARGET}" "${CURRENT_LINK}"
    export RELEASE_ID="${PREVIOUS_TARGET##*/}"
    docker compose --project-name ai-research-agent \
      --env-file "${ENV_FILE}" \
      -f "${CURRENT_LINK}/deploy/server/docker-compose.yml" up -d || true
    docker compose --project-name ai-research-agent --env-file "${ENV_FILE}" \
      -f "${CURRENT_LINK}/deploy/server/docker-compose.yml" up -d --no-deps --force-recreate n8n || true
  elif [[ -L "${CURRENT_LINK}" ]]; then
    docker compose --project-name ai-research-agent --env-file "${ENV_FILE}" \
      -f "${CURRENT_LINK}/deploy/server/docker-compose.yml" down || true
    rm -f "${CURRENT_LINK}"
  fi
}
trap rollback ERR

# Reuse only the existing Feishu bot identity. Group chat_id takes priority.
# The research service remains otherwise independent from the customer-service stack.
set -a
# shellcheck disable=SC1090
source "${SOURCE_ENV}"
set +a
FEISHU_RESEARCH_RECIPIENT_OPEN_ID="${FEISHU_OPS_ADMIN_OPEN_IDS%%,*}"
if [[ "${FEISHU_RESEARCH_RECIPIENT_OPEN_ID}" != ou_* ]]; then
  while IFS= read -r backup_file; do
    historical_ids="$(sed -n 's/^FEISHU_OPS_ADMIN_OPEN_IDS=//p' "${backup_file}" | tail -1)"
    if [[ "${historical_ids}" == ou_* && "${historical_ids}" != *,* ]]; then
      FEISHU_RESEARCH_RECIPIENT_OPEN_ID="${historical_ids}"
      break
    fi
  done < <(find "$(dirname "${SOURCE_ENV}")" -maxdepth 1 -type f -name 'app.env.bak-*' -print | sort -r)
fi
if [[ -z "${FEISHU_CUSTOM_APP_ID:-}" || -z "${FEISHU_CUSTOM_APP_SECRET:-}" ]]; then
  echo "Existing Feishu bot credentials are incomplete in ${SOURCE_ENV}" >&2
  exit 1
fi
if [[ -n "${FEISHU_RESEARCH_CHAT_ID:-}" && "${FEISHU_RESEARCH_CHAT_ID}" != oc_* ]]; then
  echo "FEISHU_RESEARCH_CHAT_ID must start with oc_" >&2
  exit 1
fi
if [[ -z "${FEISHU_RESEARCH_CHAT_ID:-}" && "${FEISHU_RESEARCH_RECIPIENT_OPEN_ID}" != ou_* ]]; then
  echo "Neither a valid Feishu chat_id nor admin open_id is available" >&2
  exit 1
fi
append_env_if_missing() {
  local name="$1"
  local value="$2"
  if ! grep -q "^${name}=" "${ENV_FILE}"; then
    printf '%s=%s\n' "${name}" "${value}" >> "${ENV_FILE}"
  fi
}
append_env_if_missing FEISHU_RESEARCH_ENABLED 1
append_env_if_missing FEISHU_RESEARCH_APP_ID "${FEISHU_CUSTOM_APP_ID}"
append_env_if_missing FEISHU_RESEARCH_APP_SECRET "${FEISHU_CUSTOM_APP_SECRET}"
append_env_if_missing FEISHU_RESEARCH_RECIPIENT_OPEN_ID "${FEISHU_RESEARCH_RECIPIENT_OPEN_ID}"
append_env_if_missing CODEX_RESETS_ENABLED 0
append_env_if_missing CODEX_RESETS_POLL_SECONDS 300
append_env_if_missing CODEX_RESETS_JITTER_SECONDS 60
append_env_if_missing CODEX_RESETS_TIMEOUT_MS 12000
upsert_env() {
  local name="$1"
  local value="$2"
  local temporary
  temporary="$(mktemp "${SHARED_DIR}/app.env.XXXXXX")"
  grep -v "^${name}=" "${ENV_FILE}" > "${temporary}" || true
  printf '%s=%s\n' "${name}" "${value}" >> "${temporary}"
  chmod 600 "${temporary}"
  mv "${temporary}" "${ENV_FILE}"
}
if [[ -n "${FEISHU_RESEARCH_CHAT_ID:-}" ]]; then
  upsert_env FEISHU_RESEARCH_CHAT_ID "${FEISHU_RESEARCH_CHAT_ID}"
fi
# Existing installations keep app.env across releases, so an explicit upsert
# is required for the production model migration.
upsert_env BAILIAN_MODEL qwen3.8-max
if [[ "${ENABLE_CODEX_RESETS:-0}" == '1' ]]; then
  upsert_env CODEX_RESETS_ENABLED 1
fi

if [[ "$(stat -c '%a' "${ENV_FILE}")" != '600' ]]; then
  chmod 600 "${ENV_FILE}"
fi
if ! grep -q '^BAILIAN_API_KEY=.' "${ENV_FILE}"; then
  echo "BAILIAN_API_KEY is missing from ${ENV_FILE}" >&2
  false
fi

ln -sfn "releases/${RELEASE_ID}" "${CURRENT_LINK}"
COMPOSE_FILE="${CURRENT_LINK}/deploy/server/docker-compose.yml"

export RELEASE_ID
docker compose --project-name ai-research-agent --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" config --quiet
docker compose --project-name ai-research-agent --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" build research-agent
docker compose --project-name ai-research-agent --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" up -d --remove-orphans
# The bind mount uses the stable current/ path. Docker cannot detect that its
# symlink now points at a different release; recreate n8n to reload and publish.
docker compose --project-name ai-research-agent --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" \
  up -d --no-deps --force-recreate n8n

for _ in $(seq 1 48); do
  if curl --fail --silent --max-time 5 http://127.0.0.1:8787/health >/dev/null \
    && curl --fail --silent --max-time 5 http://127.0.0.1:5678/healthz >/dev/null; then
    break
  fi
  sleep 5
done
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8787/health >/dev/null
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:5678/healthz >/dev/null

# Validate the published version, not just the editable workflow definition.
python3 - <<'PY'
import json, pathlib, sqlite3, subprocess
container = json.loads(subprocess.check_output(['docker', 'inspect', 'ai-research-n8n'], text=True))[0]
data = next(m['Source'] for m in container['Mounts'] if m['Destination'] == '/home/node/.n8n')
con = sqlite3.connect('file:' + str(pathlib.Path(data) / 'database.sqlite') + '?mode=ro', uri=True)
row = con.execute('SELECT active, activeVersionId, settings FROM workflow_entity WHERE id = ?',
                  ('5f052327-5b10-4c57-bff0-a364d4b52d21',)).fetchone()
assert row and row[0] and row[1], 'Daily workflow is not published'
assert json.loads(row[2])['timezone'] == 'Asia/Shanghai', 'Daily workflow timezone mismatch'
nodes = json.loads(con.execute('SELECT nodes FROM workflow_history WHERE versionId = ?', (row[1],)).fetchone()[0])
trigger = next(n for n in nodes if n['type'] == 'n8n-nodes-base.scheduleTrigger')
assert trigger['parameters']['rule']['interval'][0]['expression'] == '0 30 8 * * *', 'Active daily schedule mismatch'
PY

if [[ "${RUN_SMOKE:-1}" == '1' ]]; then
  curl --fail --silent --show-error --max-time 540 -X POST http://127.0.0.1:8787/run > "${SHARED_DIR}/last-smoke.json"
  chmod 600 "${SHARED_DIR}/last-smoke.json"
  grep -Eq '"model"[[:space:]]*:[[:space:]]*"qwen3\.8-max"' "${SHARED_DIR}/last-smoke.json"
  grep -Eq '"modelDegraded"[[:space:]]*:[[:space:]]*false' "${SHARED_DIR}/last-smoke.json"
fi

docker exec ai-research-postgres psql -U research_agent -d ai_research -Atc \
  "SELECT 'runs=' || count(*) FROM research_runs" >/dev/null

if [[ "${ENABLE_CODEX_RESETS:-0}" == '1' ]]; then
  # First startup records the API history without sending historical alerts.
  # Wait for that initialization independently of the expensive paper pipeline.
  for _ in $(seq 1 30); do
    if curl --fail --silent --max-time 5 http://127.0.0.1:8787/codex-resets/status \
      | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("enabled") and (d.get("monitor") or {}).get("initialized_at") else 1)'; then
      break
    fi
    sleep 5
  done
  curl --fail --silent --max-time 5 http://127.0.0.1:8787/codex-resets/status \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["enabled"] and d["monitor"]["initialized_at"]'
fi

trap - ERR
printf '%s\n' "releases/${RELEASE_ID}" > "${LAST_GOOD_FILE}"
chmod 600 "${LAST_GOOD_FILE}"
echo "Release ${RELEASE_ID} is healthy"
