export interface Step { id: number; text: string; done: boolean }
export interface Item {
  id: number; title: string; subject: string; kind: string; body: string; link_url: string;
  filename: string; file_url: string; mime: string; created: string;
  due: string; due_raw: string; due_time: string; visible_at: string; hidden: boolean;
  pinned: boolean; done: boolean; done_at: string; child_id: number; shared: boolean;
  est_minutes: number; remind: string; focus_minutes: number; steps: Step[];
}
export interface Prefs { remind: boolean; before: number; daily: boolean; dailyAt: string; focus: number; rest: number; lockDetail: boolean }
export interface Child { id: number; name: string }
export interface Me {
  role: 'parent' | 'student'; child_id: number; children: Child[]; subjects: string[];
  kinds: { code: string; label: string }[]; features: { ai: boolean; voice: boolean }; push: { publicKey: string };
}
export type DayStatus = 'ok' | 'late' | 'none' | 'today' | 'future';
export interface Stats {
  streak: number; lastLate: string; onTimeRate: number | null;
  days: { date: string; status: DayStatus }[]; week: { date: string; minutes: number | null }[];
  prevSameSpan: number; weekDone: number; weekTotal: number;
}
export interface Draft { title: string; subject: string; kind: string; child_id: number; due: string; body: string }
