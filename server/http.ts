import type { Context } from 'hono';
import type { Session } from './auth.js';
import type { UploadFile } from './items.js';

export type Env = { Variables: { session: Session | null } };

/** 把 multipart / urlencoded / JSON 统一成「字符串字段 + 一个文件」，和旧版 read_form 一样。 */
export async function readForm(c: Context): Promise<{ fields: Record<string, string>; file?: UploadFile }> {
  const ctype = (c.req.header('content-type') || '').toLowerCase();
  const fields: Record<string, string> = {};
  let file: UploadFile | undefined;
  try {
    if (ctype.startsWith('application/json')) {
      const obj = await c.req.json();
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        for (const [k, v] of Object.entries(obj)) {
          // 与旧版的差别：JSON 里的 false / null 当空值（旧版会变成字符串 "False" / "None"，被当成真）。
          if (v === null || v === undefined || v === false) fields[k] = '';
          else if (v === true) fields[k] = '1';
          else fields[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
        }
      }
    } else if (ctype.startsWith('multipart/form-data') || ctype.startsWith('application/x-www-form-urlencoded')) {
      const body = await c.req.parseBody({ all: true });
      for (const [k, raw] of Object.entries(body)) {
        for (const v of Array.isArray(raw) ? raw : [raw]) {
          if (typeof v === 'string') fields[k] = v;
          else if (v && typeof (v as File).arrayBuffer === 'function') {
            const f = v as File;
            if (!f.name && !f.size) { fields[k] = ''; continue; }
            file = { bytes: Buffer.from(await f.arrayBuffer()), name: f.name || '', type: (f.type || '').toLowerCase() };
          }
        }
      }
    }
  } catch {
    return { fields: {} };
  }
  return { fields, file };
}

export async function readJson(c: Context): Promise<Record<string, any>> {
  try {
    const v = await c.req.json();
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export const contentLength = (c: Context) => Number.parseInt(c.req.header('content-length') || '0', 10) || 0;
export const err = (c: Context, status: number, error: string, message = '') =>
  c.json(message ? { ok: false, error, message } : { ok: false, error }, status as any);
