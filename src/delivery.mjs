import { recordDelivery, supersedePreviousDelivery, wasDelivered } from './database.mjs';
import { resolveFeishuTarget, sendFeishuDigest } from './feishu.mjs';

export const deliverReport = async (report, config, signal, { force = false } = {}) => {
  if (!config.feishuEnabled) return { enabled: false, status: 'disabled', attempts: 0 };
  const target = resolveFeishuTarget(config);

  // Refuse before any network call so an empty run can never be recorded as
  // a successful delivery, no matter which entry point asked for it.
  if (!report.papers || report.papers.length === 0) {
    const delivery = {
      enabled: true,
      status: 'blocked-empty',
      attempts: 0,
      targetType: target.type,
      reason: 'Digest contains zero papers; delivery blocked by the empty-result gate'
    };
    await recordDelivery(config, report.runId, report.date, target.channel, delivery);
    return delivery;
  }

  let delivery;
  if (!force && await wasDelivered(config, report.date, target.channel)) {
    delivery = {
      enabled: true,
      status: 'skipped',
      attempts: 0,
      targetType: target.type,
      reason: 'Already delivered for this date and channel'
    };
  } else {
    delivery = await sendFeishuDigest(report, config, signal);
    // A forced replay corrects an earlier bad push: keep that row for audit,
    // but release the unique "one live delivery per date+channel" slot. Only
    // supersede once the corrected digest is actually out, so a failed replay
    // leaves the original record untouched.
    if (force && delivery.status === 'delivered') {
      await supersedePreviousDelivery(config, report.date, target.channel);
    }
  }
  await recordDelivery(config, report.runId, report.date, target.channel, delivery);
  return delivery;
};
