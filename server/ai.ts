import { randomBytes } from 'node:crypto';
import { aiDefaultDue, isoDate } from '../shared/dates.js';
import type { Config } from './config.js';
import { KINDS } from './items.js';

export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
export const AUDIO_TYPES: Record<string, string> = {
  'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a',
  'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3',
};

export interface Draft { title: string; subject: string; kind: string; child_id: number; due: string; body: string }
export type Result<T> = { ok: true; value: T } | { ok: false; error: string; message: string };
const fail = (error: string, message: string): Result<never> => ({ ok: false, error, message });

/** 模型或粘贴来的草稿只做校验和归一，不入库；学科、孩子对不上就留空，让用户在草稿卡里手选。 */
export function validateDraft(raw: unknown, subjects: string[], children: { id: number; name: string }[], defaultChild = 0): Draft {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { title: '', subject: '', kind: '', child_id: defaultChild, due: '', body: '' };
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (v === null || v === undefined || v === false ? '' : String(v)).trim();
  const subject = subjects.includes(str(r.subject)) ? str(r.subject) : '';
  const kind = KINDS[str(r.kind)] ? str(r.kind) : '';
  let childId = defaultChild;
  const cid = Number.parseInt(str(r.child_id) || '0', 10);
  if (!Number.isNaN(cid) && (cid === 0 || children.some((c) => c.id === cid))) childId = cid;
  if (str(r.child_name)) for (const c of children) if (c.name === str(r.child_name)) childId = c.id;
  const due = /^\d{4}-\d{2}-\d{2}$/.test(str(r.due)) ? str(r.due) : '';
  return { title: str(r.title), subject, kind, child_id: childId, due, body: str(r.body) };
}

/**
 * 识别连续编号的任务列表（1. / 1、 / 1) / (1) / （1） / “1 任务 2 任务”），页码、小数、日期不算。
 * 至少两条、从 1 开始连续；纯数字列表（第 1 2 3 题）和不连续的编号原样交给模型。
 */
export function numberedEntries(text: string): [string, string[]] | null {
  const re = /(?<![0-9A-Za-z_.])(?:[（(](\d{1,2})[）)]|([0-9]{1,2})[、．.)）](?!\d)|([0-9]{1,2})(?=\s+[^\d\s]))/g;
  const matches = [...text.matchAll(re)];
  if (matches.length < 2) return null;
  const numbers = matches.map((m) => Number(m[1] ?? m[2] ?? m[3]));
  if (numbers.some((n, i) => n !== i + 1)) return null;
  const trim = (s: string) => s.replace(/^[ \t\r\n;；]+|[ \t\r\n;；]+$/g, '');
  const entries = matches.map((m, i) => trim(text.slice(m.index! + m[0].length, i + 1 < matches.length ? matches[i + 1].index : text.length)));
  if (entries.some((e) => !e || !/[^\d\s、，,。.;；:：()（）-]/.test(e))) return null;
  return [text.slice(0, matches[0].index).trim(), entries];
}

export interface ParseContext {
  cfg: Config;
  subjects: string[];
  children: { id: number; name: string }[];
  defaultChild: number | null;
  today?: Date;
  fetchImpl?: typeof fetch;
}

export async function callLlmParse(text: string, image: { bytes: Buffer; type: string } | null, ctx: ParseContext): Promise<Result<Draft[]>> {
  const numbered = numberedEntries(text);
  let normalized = text;
  if (numbered) normalized = numbered[0] + '\n' + numbered[1].map((e, i) => `${i + 1}. ${e}`).join('\n');
  const first = await parseOnce(normalized, image, ctx);
  if (!first.ok || !numbered || image || first.value.length >= numbered[1].length) return first;
  // 模型把编号任务合并了：逐条单独解析，保留共同背景，但不复制被合并任务的日期。只生成草稿，不写库。
  const [prefix, entries] = numbered;
  const results = await Promise.all(entries.map((e) => parseOnce((prefix ? `共同背景（适用于本条）：${prefix}\n` : '') + '本条独立任务：' + e, null, ctx)));
  const combined: Draft[] = [];
  for (const r of results) {
    if (!r.ok) return r;
    if (!r.value.length) return fail('llm_empty_draft', '有编号任务未生成草稿，请重试；尚未创建任何作业。');
    combined.push(...r.value);
  }
  return { ok: true, value: combined };
}

async function parseOnce(text: string, image: { bytes: Buffer; type: string } | null, ctx: ParseContext): Promise<Result<Draft[]>> {
  const { cfg } = ctx;
  if (!cfg.llm.key) return fail('llm_not_configured', '未配置 LLM_API_KEY，改用手动填写，或在部署环境里设 LLM_API_KEY。');
  const today = ctx.today || new Date();
  const model = image && cfg.llm.visionModel ? cfg.llm.visionModel : cfg.llm.model;
  let system = '你是作业登记解析器，只输出 JSON 数组，不要输出任何其他文字或 Markdown。'
    + '每项字段：title（标题）、subject（学科，必须是下面列表里的原样字符串，对不上就留空）、'
    + 'kind（notice/homework/material/answer/listening/announcement，对不上就留空）、'
    + 'child_id（页面选定的孩子 id）、due（YYYY-MM-DD，没有明确日期就留空，由服务端为作业填入默认截止日）、body（正文）。'
    + `今天是 ${isoDate(today)}，相对日期（明天、下周五等）要换算成绝对日期。`
    + `未说明日期时 due 留空，不猜测日期；服务端会为作业填 ${aiDefaultDue(today)}（通常当天，周五登记则周日）。明确日期优先，不得把明确周五改成周日。`
    + '同一行的多个独立任务也必须拆开，不能只按换行或学科拆分。'
    + '例如‘语文：1.抄写生字 2.背诵课文 3.阅读课外书’必须输出三项；1、2、3、(1)(2)、1 任务 2 任务等同理。'
    + '每个编号任务独立保留所属学科、正文与截止日期；页码、题号范围（第1、2、3题）、小数和日期不要误拆。'
    + `学科列表：${JSON.stringify(ctx.subjects)}。孩子列表：${JSON.stringify(ctx.children)}。`;
  if (ctx.defaultChild !== null) {
    const target = ctx.defaultChild ? ctx.children.find((c) => c.id === ctx.defaultChild)?.name || '' : '共享';
    system += `本次登记对象已由用户在页面选定：${target}（child_id=${ctx.defaultChild}）。所有草稿都使用此 child_id，不根据正文姓名猜测或改变归属，用户会在核对页自行修改。`;
  }
  const content = image
    ? [{ type: 'text', text: text || '请解析这张图里的作业和通知，按学科拆成多条。' },
       { type: 'image_url', image_url: { url: `data:${image.type.startsWith('image/') ? image.type : 'image/jpeg'};base64,${image.bytes.toString('base64')}` } }]
    : text;
  let data: any;
  try {
    const res = await (ctx.fetchImpl || fetch)(cfg.llm.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + cfg.llm.key, 'Content-Type': 'application/json', 'User-Agent': 'school-board/2.0' },
      body: JSON.stringify({ model, temperature: 0.2, messages: [{ role: 'system', content: system }, { role: 'user', content }] }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) return fail('llm_error', `模型接口返回 ${res.status}，检查 LLM_BASE_URL / LLM_MODEL / key 是否正确。`);
    data = await res.json();
  } catch {
    return fail('llm_error', '模型服务连接失败，请检查配置或改用手动填写。');
  }
  const out = data?.choices?.[0]?.message?.content;
  if (typeof out !== 'string') return fail('llm_bad_json', '模型返回格式不对，换个模型或重试一次。');
  let list: unknown;
  try {
    list = JSON.parse(out.slice(out.indexOf('['), out.lastIndexOf(']') + 1));
  } catch {
    return fail('llm_bad_json', '模型没有返回可解析的 JSON 数组，重试一次或改用手动填写。');
  }
  if (!Array.isArray(list)) return fail('llm_bad_json', '模型返回的不是数组，重试一次或改用手动填写。');
  const drafts = list.map((r) => validateDraft(r, ctx.subjects, ctx.children, ctx.defaultChild || 0));
  for (const d of drafts) {
    if (d.kind === 'homework' && !d.due) d.due = aiDefaultDue(today);
    if (ctx.defaultChild !== null) d.child_id = ctx.defaultChild;
  }
  return { ok: true, value: drafts };
}

/** OpenAI 兼容的语音转写。录音只在内存里转发，不落盘；上游的错误内容不回显给页面。 */
export async function transcribe(cfg: Config, bytes: Buffer | undefined, type: string, fetchImpl: typeof fetch = fetch): Promise<Result<string>> {
  if (!cfg.stt.key) return fail('stt_not_configured', '未配置 STT_API_KEY，请先配置语音服务，或改用文字 / 照片。');
  const mime = (type || '').split(';')[0].trim().toLowerCase();
  if (!AUDIO_TYPES[mime]) return fail('unsupported_audio', '不支持这种音频格式，请使用 WebM、MP4/M4A、WAV、MP3 或 Ogg。');
  if (!bytes || !bytes.length) return fail('empty_audio', '没有录到声音，请重新录音。');
  if (bytes.length > MAX_AUDIO_BYTES) return fail('audio_too_large', '音频最大 10MB，请缩短录音。');
  const boundary = 'SchoolBoardSpeech' + randomBytes(16).toString('hex');
  const head = (name: string, value: string) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  const body = Buffer.concat([
    head('model', cfg.stt.model), head('response_format', 'json'),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="recording.${AUDIO_TYPES[mime]}"\r\nContent-Type: ${mime}\r\n\r\n`),
    bytes, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  let result: any;
  try {
    const res = await fetchImpl(cfg.stt.baseUrl.replace(/\/+$/, '') + '/audio/transcriptions', {
      method: 'POST', body: new Uint8Array(body),
      headers: { Authorization: 'Bearer ' + cfg.stt.key, 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'User-Agent': 'school-board/2.0' },
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) return fail('stt_error', `语音服务返回 ${res.status}，请检查 STT 配置及音频格式支持。`);
    result = await res.json();
  } catch {
    return fail('stt_error', '语音服务连接失败或返回无效数据，请重试或改用文字。');
  }
  const text = result && typeof result === 'object' ? result.text : null;
  if (typeof text !== 'string' || !text.trim()) return fail('empty_transcript', '未识别到文字，请靠近麦克风重新录音，或改用文字。');
  return { ok: true, value: text.trim() };
}
