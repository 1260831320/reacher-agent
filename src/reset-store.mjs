import { createHash } from 'node:crypto';
import pg from 'pg';

export const eventKey = (event) => `${event.id}:${event.reset_type}`;
export const deliveryUuid = (event, target) => createHash('sha256')
  .update(JSON.stringify([event.id, event.reset_type, target.type, target.id]))
  .digest('hex').slice(0, 40);

export const createResetStore = (config) => {
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 2, connectionTimeoutMillis: 5000 });
  return {
    async withLock(callback) {
      const client = await pool.connect();
      let locked = false;
      try {
        locked = (await client.query('SELECT pg_try_advisory_lock(724311, 1) AS locked')).rows[0].locked;
        if (!locked) return { status: 'busy', delayMs: config.codexResetsPollMs };
        await client.query('INSERT INTO research_codex_monitor (id) VALUES (1) ON CONFLICT DO NOTHING');
        const session = {
          async state() {
            return (await client.query('SELECT * FROM research_codex_monitor WHERE id = 1')).rows[0];
          },
          async ingest(events, targets, baseline, etag, now, nextPoll) {
            await client.query('BEGIN');
            try {
              for (const event of events) {
                const inserted = await client.query(
                  `INSERT INTO research_codex_events (event_id, reset_type, payload, baseline)
                   VALUES ($1, $2, $3::jsonb, $4) ON CONFLICT DO NOTHING RETURNING event_id`,
                  [event.id, event.reset_type, JSON.stringify(event), baseline]
                );
                if (!baseline && inserted.rowCount) {
                  for (const target of targets) {
                    await client.query(
                      `INSERT INTO research_codex_deliveries (event_id, reset_type, target_type, target_id, uuid)
                       VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
                      [event.id, event.reset_type, target.type, target.id, deliveryUuid(event, target)]
                    );
                  }
                }
              }
              await client.query(
                `UPDATE research_codex_monitor SET initialized_at = COALESCE(initialized_at, $1),
                 etag = $2, next_poll_at = $3, last_success_at = $1, failures = 0, last_error = '' WHERE id = 1`,
                [now, etag, nextPoll]
              );
              await client.query('COMMIT');
            } catch (error) {
              await client.query('ROLLBACK');
              throw error;
            }
          },
          async pollFailed(error, nextPoll) {
            await client.query(
              `UPDATE research_codex_monitor SET failures = failures + 1, last_error = $1,
               next_poll_at = $2 WHERE id = 1`, [error.message.slice(0, 500), nextPoll]
            );
          },
          async dueDeliveries(now) {
            // Feishu's UUID deduplication lasts one hour. A request with an unknown
            // outcome must not be blindly repeated after that window (including
            // when the process crashed between send and recording success).
            await client.query(
              `UPDATE research_codex_deliveries SET status = 'uncertain',
               last_error = 'Delivery outcome needs reconciliation; Feishu UUID retry window expired'
               WHERE status = 'sending' AND first_attempt_at <= $1::timestamptz - interval '50 minutes'`, [now]
            );
            return (await client.query(
              `SELECT d.*, e.payload FROM research_codex_deliveries d
               JOIN research_codex_events e USING (event_id, reset_type)
               WHERE d.status IN ('pending', 'sending') AND d.next_attempt_at <= $1
               ORDER BY e.first_seen_at, d.event_id, d.target_type LIMIT 10`, [now]
            )).rows;
          },
          async attempt(delivery, now) {
            await client.query(
              `UPDATE research_codex_deliveries SET status = 'sending', attempts = attempts + 1,
               first_attempt_at = COALESCE(first_attempt_at, $5)
               WHERE event_id = $1 AND reset_type = $2 AND target_type = $3 AND target_id = $4`,
              [delivery.event_id, delivery.reset_type, delivery.target_type, delivery.target_id, now]
            );
          },
          async delivered(delivery, messageId, now) {
            await client.query(
              `UPDATE research_codex_deliveries SET status = 'delivered', message_id = $5,
               delivered_at = $6, last_error = ''
               WHERE event_id = $1 AND reset_type = $2 AND target_type = $3 AND target_id = $4`,
              [delivery.event_id, delivery.reset_type, delivery.target_type, delivery.target_id, messageId, now]
            );
          },
          async deliveryFailed(delivery, error, nextAttempt) {
            const uncertain = delivery.status === 'sending' || error.deliveryUncertain === true;
            await client.query(
              `UPDATE research_codex_deliveries SET status = $5, last_error = $6, next_attempt_at = $7,
               first_attempt_at = CASE WHEN $5 = 'sending' THEN first_attempt_at ELSE NULL END
               WHERE event_id = $1 AND reset_type = $2 AND target_type = $3 AND target_id = $4`,
              [delivery.event_id, delivery.reset_type, delivery.target_type, delivery.target_id,
                uncertain ? 'sending' : 'pending', error.message.slice(0, 500), nextAttempt]
            );
          },
          async nextDeliveryDelay(now) {
            const row = (await client.query(
              `SELECT min(next_attempt_at) AS next FROM research_codex_deliveries
               WHERE status IN ('pending', 'sending')`
            )).rows[0];
            return row.next ? Math.max(5000, new Date(row.next).getTime() - now) : Infinity;
          }
        };
        return await callback(session);
      } finally {
        try {
          if (locked) await client.query('SELECT pg_advisory_unlock(724311, 1)');
          client.release();
        } catch (error) {
          client.release(true);
          throw error;
        }
      }
    },
    async summary() {
      const monitor = (await pool.query('SELECT * FROM research_codex_monitor WHERE id = 1')).rows[0];
      const counts = (await pool.query(
        'SELECT status, count(*)::int AS count FROM research_codex_deliveries GROUP BY status'
      )).rows;
      const events = (await pool.query(
        'SELECT count(*)::int AS total, count(*) FILTER (WHERE baseline)::int AS baseline FROM research_codex_events'
      )).rows[0];
      return { monitor, events, deliveries: Object.fromEntries(counts.map((row) => [row.status, row.count])) };
    },
    close: () => pool.end()
  };
};
