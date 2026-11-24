import { resolve } from 'node:path';

export interface Config {
  dataDir: string;
  uploadDir: string;
  dbPath: string;
  port: number;
  adminPassword: string;
  apiToken: string;
  llm: { key: string; baseUrl: string; model: string; visionModel: string };
  stt: { key: string; baseUrl: string; model: string };
  vapid: { publicKey: string; privateKey: string; subject: string };
  webDir: string;
  scheduler: boolean;
}

/** 环境变量与旧版完全一致，另加可选的 VAPID_* 和 WEB_DIR。 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = resolve(env.DATA_DIR || 'data');
  return {
    dataDir,
    uploadDir: resolve(dataDir, 'uploads'),
    dbPath: resolve(dataDir, 'board.db'),
    port: Number(env.PORT || 8765),
    adminPassword: env.ADMIN_PASSWORD || 'admin123',
    apiToken: env.API_TOKEN || '',
    llm: {
      key: env.LLM_API_KEY || '',
      baseUrl: env.LLM_BASE_URL || 'https://api.deepseek.com/v1',
      model: env.LLM_MODEL || 'deepseek-chat',
      visionModel: env.LLM_VISION_MODEL || '',
    },
    stt: {
      key: env.STT_API_KEY || '',
      baseUrl: env.STT_BASE_URL || 'https://api.openai.com/v1',
      model: env.STT_MODEL || 'whisper-1',
    },
    vapid: {
      publicKey: env.VAPID_PUBLIC_KEY || '',
      privateKey: env.VAPID_PRIVATE_KEY || '',
      subject: env.VAPID_SUBJECT || 'mailto:school-board@example.com',
    },
    webDir: resolve(env.WEB_DIR || 'dist/web'),
    scheduler: env.SCHEDULER !== '0',
  };
}
