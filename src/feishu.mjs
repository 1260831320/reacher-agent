const BASE_URL = 'https://open.feishu.cn/open-apis';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const requestToken = async (config, signal) => {
  const response = await fetch(`${BASE_URL}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: config.feishuAppId, app_secret: config.feishuAppSecret })
  });
  const body = await response.json();
  if (!response.ok || body.code !== 0 || !body.tenant_access_token) {
    throw new Error(`Feishu token request failed: HTTP ${response.status}, code ${body.code ?? 'unknown'}`);
  }
  return body.tenant_access_token;
};

export const buildFeishuDigest = ({ date, papers, trends = [], model }) => {
  const lines = [
    `📚 AI 论文日报 · ${date}`,
    `模型：${model}｜精选 ${papers.length} 篇｜Top 3 已审阅正文`,
    ''
  ];
  papers.forEach((paper, index) => {
    lines.push(`${index + 1}. ${paper.title}`);
    lines.push(`评分 ${paper.totalScore.toFixed(1)}｜${(paper.tags || []).slice(0, 3).join(' / ')}`);
    lines.push(paper.oneSentence);
    lines.push(`价值：${paper.whyImportant}`);
    if (paper.githubUrl) lines.push(`代码：${paper.githubUrl}`);
    lines.push(`论文：${paper.url}`, '');
  });
  if (trends.length > 0) {
    lines.push(`近 14 日高频：${trends.slice(0, 5).map((trend) => `${trend.tag}(${trend.appearances})`).join('、')}`);
  }
  lines.push('', '由独立 AI Research Agent 自动生成；正文结论请以原论文为准。');
  return lines.join('\n').slice(0, 28_000);
};

export const resolveFeishuTarget = (config) => config.feishuRecipientChatId
  ? { id: config.feishuRecipientChatId, type: 'chat_id', channel: 'feishu-group' }
  : { id: config.feishuRecipientOpenId, type: 'open_id', channel: 'feishu-private' };

const sendOnce = async (digest, config, target, signal, uuid) => {
  let token;
  try {
    token = await requestToken(config, signal);
  } catch (error) {
    error.deliveryUncertain = false;
    throw error;
  }
  let response;
  let body;
  try {
    response = await fetch(`${BASE_URL}/im/v1/messages?receive_id_type=${target.type}`, {
      method: 'POST',
      signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        receive_id: target.id,
        msg_type: 'text',
        content: JSON.stringify({ text: digest }),
        ...(uuid ? { uuid } : {})
      })
    });
    body = await response.json();
  } catch (error) {
    // The request may have reached Feishu. Retry only inside its UUID window.
    error.deliveryUncertain = true;
    throw error;
  }
  if (!response.ok || body.code !== 0) {
    const error = new Error(`Feishu message failed: HTTP ${response.status}, code ${body.code ?? 'unknown'} ${String(body.msg || '').slice(0, 120)}`);
    error.deliveryUncertain = false;
    throw error;
  }
  return body.data?.message_id || '';
};

export const sendFeishuText = async (text, config, target, signal, uuid) => {
  const messageId = await sendOnce(text, config, target, signal, uuid);
  if (!messageId) {
    const error = new Error('Feishu accepted the request without a message id');
    error.deliveryUncertain = true;
    throw error;
  }
  return messageId;
};

export const sendFeishuDigest = async (report, config, signal) => {
  if (!config.feishuEnabled) return { enabled: false, status: 'disabled', attempts: 0 };
  // Last line of defence: no caller may push a digest with nothing in it,
  // including the manual /deliver/latest replay path.
  if (!report.papers || report.papers.length === 0) {
    return {
      enabled: true,
      status: 'blocked-empty',
      attempts: 0,
      targetType: resolveFeishuTarget(config).type,
      reason: 'Digest contains zero papers'
    };
  }
  const target = resolveFeishuTarget(config);
  if (!config.feishuAppId || !config.feishuAppSecret || !target.id) {
    return { enabled: true, status: 'misconfigured', attempts: 0, targetType: target.type, error: 'Feishu app credentials or recipient id is missing' };
  }
  const digest = buildFeishuDigest(report);
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const messageId = await sendOnce(digest, config, target, signal);
      return { enabled: true, status: 'delivered', attempts: attempt, targetType: target.type, messageId };
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(attempt * 1_000);
    }
  }
  return { enabled: true, status: 'failed', attempts: 3, targetType: target.type, error: lastError?.message || 'Unknown Feishu delivery error' };
};

export const sendFeishuAlert = async (text, config, signal) => {
  if (!config.feishuEnabled || !config.alertOnEmpty) return { status: 'disabled', attempts: 0 };
  const target = resolveFeishuTarget(config);
  if (!config.feishuAppId || !config.feishuAppSecret || !target.id) {
    return { status: 'misconfigured', attempts: 0, targetType: target.type };
  }
  try {
    const messageId = await sendOnce(text, config, target, signal);
    return { status: 'sent', attempts: 1, targetType: target.type, messageId };
  } catch (error) {
    return { status: 'failed', attempts: 1, targetType: target.type, error: error.message };
  }
};
