const intFromEnv = (name, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
};

export const loadConfig = () => ({
  port: intFromEnv('RESEARCH_AGENT_PORT', 8787, 1, 65535),
  timezone: process.env.TZ || 'Asia/Tokyo',
  arxivMaxResults: intFromEnv('ARXIV_MAX_RESULTS', 100, 1, 300),
  arxivLookbackDays: intFromEnv('ARXIV_LOOKBACK_DAYS', 4, 1, 30),
  shortlistSize: intFromEnv('SHORTLIST_SIZE', 12, 1, 30),
  dailyTopCount: intFromEnv('DAILY_TOP_COUNT', 5, 1, 15),
  pdfEvidenceCount: intFromEnv('PDF_EVIDENCE_COUNT', 3, 0, 10),
  pdfMaxBytes: intFromEnv('PDF_MAX_BYTES', 25_000_000, 1_000_000, 100_000_000),
  pdfMaxChars: intFromEnv('PDF_MAX_CHARS', 55_000, 5_000, 150_000),
  externalSourceTimeoutMs: intFromEnv('EXTERNAL_SOURCE_TIMEOUT_MS', 12_000, 1_000, 60_000),
  bailianApiKey: process.env.BAILIAN_API_KEY || '',
  bailianApiUrl: process.env.BAILIAN_API_URL || 'https://dashscope-us.aliyuncs.com/apps/anthropic/v1/messages',
  bailianProtocol: process.env.BAILIAN_PROTOCOL || 'anthropic',
  bailianModel: process.env.BAILIAN_MODEL || 'qwen3.8-max',
  databaseUrl: process.env.DATABASE_URL || '',
  huggingFaceToken: process.env.HF_TOKEN || '',
  githubToken: process.env.GITHUB_TOKEN || '',
  feishuEnabled: process.env.FEISHU_RESEARCH_ENABLED === '1',
  // A blocked digest is still an incident: alert unless explicitly muted.
  alertOnEmpty: process.env.FEISHU_ALERT_ON_EMPTY !== '0',
  feishuAppId: process.env.FEISHU_RESEARCH_APP_ID || '',
  feishuAppSecret: process.env.FEISHU_RESEARCH_APP_SECRET || '',
  feishuRecipientChatId: (process.env.FEISHU_RESEARCH_CHAT_ID || '').trim(),
  feishuRecipientOpenId: (process.env.FEISHU_RESEARCH_RECIPIENT_OPEN_ID || '').split(',')[0].trim(),
  dataDir: process.env.DATA_DIR || '/app/data',
  reportsDir: process.env.REPORTS_DIR || '/app/reports',
  dryRun: process.env.DRY_RUN === '1'
});
