CREATE TABLE IF NOT EXISTS research_runs (
  id BIGSERIAL PRIMARY KEY,
  run_date DATE NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  model TEXT NOT NULL,
  degraded BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS research_runs_date_idx ON research_runs (run_date DESC, started_at DESC);

CREATE TABLE IF NOT EXISTS research_papers (
  arxiv_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  abstract TEXT NOT NULL,
  authors JSONB NOT NULL DEFAULT '[]'::jsonb,
  categories TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  published_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  url TEXT NOT NULL,
  pdf_url TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS research_papers_published_idx ON research_papers (published_at DESC);

CREATE TABLE IF NOT EXISTS research_assessments (
  run_id BIGINT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  arxiv_id TEXT NOT NULL REFERENCES research_papers(arxiv_id) ON DELETE CASCADE,
  rank INTEGER NOT NULL,
  lexical_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_score DOUBLE PRECISION NOT NULL,
  relevance DOUBLE PRECISION NOT NULL,
  novelty DOUBLE PRECISION NOT NULL,
  engineering_value DOUBLE PRECISION NOT NULL,
  evidence_quality DOUBLE PRECISION NOT NULL,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  signals JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (run_id, arxiv_id)
);

CREATE INDEX IF NOT EXISTS research_assessments_paper_idx ON research_assessments (arxiv_id, created_at DESC);
CREATE INDEX IF NOT EXISTS research_assessments_score_idx ON research_assessments (total_score DESC);

CREATE TABLE IF NOT EXISTS research_deliveries (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT REFERENCES research_runs(id) ON DELETE SET NULL,
  run_date DATE NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('delivered', 'failed', 'skipped', 'misconfigured', 'blocked-empty', 'superseded')),
  attempts INTEGER NOT NULL DEFAULT 0,
  message_id TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS research_deliveries_success_idx
  ON research_deliveries (run_date, channel) WHERE status = 'delivered';

-- Widen the delivery status set on databases created before the fail-closed
-- gate existed. CREATE TABLE IF NOT EXISTS leaves the original CHECK in place,
-- so the constraint has to be replaced explicitly. This whole file is replayed
-- on every run, so the swap is guarded: ADD CONSTRAINT takes an ACCESS
-- EXCLUSIVE lock and revalidates the table, which should happen once, not daily.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'research_deliveries'::regclass
      AND conname = 'research_deliveries_status_check'
      AND pg_get_constraintdef(oid) LIKE '%blocked-empty%'
  ) THEN
    ALTER TABLE research_deliveries DROP CONSTRAINT IF EXISTS research_deliveries_status_check;
    ALTER TABLE research_deliveries ADD CONSTRAINT research_deliveries_status_check
      CHECK (status IN ('delivered', 'failed', 'skipped', 'misconfigured', 'blocked-empty', 'superseded'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS research_codex_monitor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  initialized_at TIMESTAMPTZ,
  etag TEXT NOT NULL DEFAULT '',
  next_poll_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_success_at TIMESTAMPTZ,
  failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS research_codex_events (
  event_id TEXT NOT NULL,
  reset_type TEXT NOT NULL CHECK (reset_type IN ('regular', 'banked')),
  payload JSONB NOT NULL,
  baseline BOOLEAN NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, reset_type)
);

CREATE TABLE IF NOT EXISTS research_codex_deliveries (
  event_id TEXT NOT NULL,
  reset_type TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('chat_id', 'open_id')),
  target_id TEXT NOT NULL,
  uuid TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'delivered', 'uncertain')),
  attempts INTEGER NOT NULL DEFAULT 0,
  first_attempt_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  message_id TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  delivered_at TIMESTAMPTZ,
  PRIMARY KEY (event_id, reset_type, target_type, target_id),
  FOREIGN KEY (event_id, reset_type) REFERENCES research_codex_events(event_id, reset_type)
);

CREATE INDEX IF NOT EXISTS research_codex_deliveries_due_idx
  ON research_codex_deliveries (next_attempt_at) WHERE status IN ('pending', 'sending');
