// 和服务器说话的唯一入口。网络断开时抛 OfflineError，调用方决定是排队还是提示。
export class OfflineError extends Error {}
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export async function api<T = any>(path: string, opts: { method?: string; json?: unknown; form?: FormData } = {}): Promise<T> {
  const init: RequestInit = { method: opts.method || (opts.json !== undefined || opts.form ? 'POST' : 'GET'), credentials: 'same-origin', headers: {} };
  if (opts.json !== undefined) {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.json);
  } else if (opts.form) init.body = opts.form;
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new OfflineError('没有网络');
  }
  let data: any = null;
  try { data = await res.json(); } catch { data = null; }
  if (res.status === 503 && res.headers.get('X-SB-Offline')) throw new OfflineError('没有网络');
  if (!res.ok || (data && data.ok === false)) {
    throw new ApiError(res.status, data?.error || 'error', data?.message || (res.status === 401 ? '请先登录' : `出错了（${res.status}）`));
  }
  if (res.headers.get('X-SB-Cache')) (data as any).__cached = res.headers.get('X-SB-Cache');
  return data as T;
}

/** 完成 / 步骤这类“明确目标状态”的请求，断网时先存起来，联网后按顺序补发。 */
const OUTBOX = 'sb-outbox';
type Queued = { path: string; json: unknown };
export function enqueue(q: Queued) {
  const list: Queued[] = JSON.parse(localStorage.getItem(OUTBOX) || '[]');
  const rest = list.filter((x) => x.path !== q.path);
  rest.push(q);
  localStorage.setItem(OUTBOX, JSON.stringify(rest));
}
export const pendingCount = () => (JSON.parse(localStorage.getItem(OUTBOX) || '[]') as Queued[]).length;
export async function flushOutbox(): Promise<number> {
  const list: Queued[] = JSON.parse(localStorage.getItem(OUTBOX) || '[]');
  let sent = 0;
  while (list.length) {
    try {
      await api(list[0].path, { json: list[0].json });
    } catch (e) {
      if (e instanceof OfflineError) break;
      // 服务器拒绝了（比如作业已被删）：丢掉这一条，不反复重试
    }
    list.shift();
    sent++;
    localStorage.setItem(OUTBOX, JSON.stringify(list));
  }
  return sent;
}
