import { recordDelivery, wasDelivered } from './database.mjs';
import { resolveFeishuTarget, sendFeishuDigest } from './feishu.mjs';

export const deliverReport = async (report, config, signal) => {
  if (!config.feishuEnabled) return { enabled: false, status: 'disabled', attempts: 0 };
  const target = resolveFeishuTarget(config);
  let delivery;
  if (await wasDelivered(config, report.date, target.channel)) {
    delivery = {
      enabled: true,
      status: 'skipped',
      attempts: 0,
      targetType: target.type,
      reason: 'Already delivered for this date and channel'
    };
  } else {
    delivery = await sendFeishuDigest(report, config, signal);
  }
  await recordDelivery(config, report.runId, report.date, target.channel, delivery);
  return delivery;
};
