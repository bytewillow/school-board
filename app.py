#!/usr/bin/env python3
"""作业板（零依赖，只用 Python 标准库）

浏览：首页一个学科一个块，点学科看这门，点标题看详情。
登记：/register 不需要密码，局域网内谁都可以登记作业、上传文件；
      标题不填就用文件名，学科在管理里加，内容可以指定给某个孩子。
管理：/admin 需要密码，只做删除、加孩子、加学科。
API：POST /api/items，curl 和 iPhone 捷径都能直接传文件。
不含微信机器人：收集先走登记上传（之后可再接微信 PC 文件夹监听）。

设计约束（2026-10-27 三条 UI skill 交叉对比后定下，之后改界面先对这条）：
- 只用 1 套风格：Bento 卡片块；只用 1 套柔和配色：底 #f4f5f7、卡片白、
  主色 #2f66c4、完成绿 #2e7d32、删除用暗红；不用玻璃化、黏土化、渐变、着色器。
- 学科展示是活页夹：大屏左侧竖排彩色标签、小屏顶部横滑标签，一次只翻一门；
  封面只放进度、提醒、各科计数，学科页只放紧凑标题行，计时器收进可展开，
  目标是一屏看完一页，不靠下拉堆内容。
- 边角协调：活页夹只有一个外框圆角 + overflow 裁剪，标签无间隙、活动标签
  背景就是纸面白、圆孔只在标签与纸面之间的脊柱上，不再各处各圆角；
  顶部不再放孩子/今天过滤，默认看全部；多孩先选本子封面、点开带翻书动画，
  单孩直接进活页夹；翻书动画 650ms（本子倾斜 300ms），比之前慢一点。
- 管理页紧凑：摘要只一行、退出放顶部、孩子/学科双栏并排、加孩子/加学科行内表单、
  已登记内容每条只一行，不再放登记表单（登记只走登记页）；登记页也不再放新学科现填
  入口（新学科只走管理），两边不再互相重复；本子页没有“不分本子看全部”入口。
- 预设学科：语文、数学、英语、物理、化学、道法、历史、地理（按此顺序）；旧库补齐
  预设并按此顺序排，非预设已有学科挪到后面，不悄悄删有内容的数据。
- 活页夹只显示有内容的学科：当前本子下条数为 0 的学科不占标签、封面各科列表也不列，
  有内容后自动出现；正在看的那门即使空也保留标签，否则空状态页找不到自己。
- PWA：manifest + 192/512 图标 + apple-touch-icon（180）+ 独立打开，Service Worker
  只为安装条件、不缓存动态内容，作业永远走网络，断网只提示一句话。
- 只用系统字体，不引外部字体：-apple-system / PingFang SC / Noto Sans SC / Microsoft YaHei。
- 状态必须齐全：键盘焦点态、加载中（防重复提交）、出错页、空状态，
  缺一个状态就不算做完；动效只做 150ms 以内的卡片/按钮过渡，且尊重复 reduced-motion。

运行：python3 app.py            # 默认 http://127.0.0.1:8765
环境变量：PORT（默认 8765）、ADMIN_PASSWORD（默认 admin123，部署前务必改）、
          API_TOKEN（可选，设了之后 API 须带 X-API-Token 头）、
          DATA_DIR（默认脚本旁的 data/，Docker 里用 /data）
数据：SQLite + data/uploads/ 文件，备份时把 data/ 整个拷走即可。
"""
import hashlib
import html
import json
import mimetypes
import os
import re
import secrets
import sqlite3
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlparse

BASE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(BASE, "data"))
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
DB_PATH = os.path.join(DATA_DIR, "board.db")
PORT = int(os.environ.get("PORT", "8765"))
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin123")
API_TOKEN = os.environ.get("API_TOKEN", "")
MAX_FILE_BYTES = 50 * 1024 * 1024

DEFAULT_SUBJECTS = ["语文", "数学", "英语", "物理", "化学", "道法", "历史", "地理"]
KINDS = {
    "notice": "通知", "homework": "作业", "material": "学习资料",
    "answer": "答案", "listening": "听力", "announcement": "提醒",
}
SUBJECT_META = {
    "语文": ("📖", "#fef3e8", "#c2702e"), "数学": ("🔢", "#e8f1fe", "#2f66c4"),
    "英语": ("🔤", "#e9f7ef", "#2e7d5b"), "物理": ("⚛️", "#eef0fd", "#4a5fc4"),
    "化学": ("🧪", "#fdf0f5", "#a83a6b"), "道法": ("⚖️", "#f2f4f7", "#5f6b7a"),
    "历史": ("📜", "#fdf6ec", "#8a6d3b"), "地理": ("🌍", "#e6f4f8", "#2e7d8a"),
    "科学": ("🔬", "#f0eafd", "#6a4fc4"), "其他": ("📁", "#f2f4f7", "#5f6b7a"),
}


def now_dt():
    return datetime.now().strftime("%Y-%m-%dT%H:%M")


def today():
    return date.today().isoformat()


def esc(s):
    return html.escape(str(s or ""), quote=True)


def safe_link(url):
    url = (url or "").strip()
    if url.startswith("http://") or url.startswith("https://"):
        return url
    return ""


def db():
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def migrate(conn):
    conn.execute("""CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
        subject TEXT NOT NULL DEFAULT '其他', kind TEXT NOT NULL DEFAULT 'notice',
        body TEXT DEFAULT '', link_url TEXT DEFAULT '',
        filename TEXT DEFAULT '', stored TEXT DEFAULT '', mime TEXT DEFAULT '',
        created TEXT NOT NULL, due TEXT DEFAULT '', visible_at TEXT DEFAULT '',
        pinned INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0,
        child_id INTEGER NOT NULL DEFAULT 0)""")
    cols = [r[1] for r in conn.execute("PRAGMA table_info(items)")]
    if "child_id" not in cols:
        conn.execute("ALTER TABLE items ADD COLUMN child_id INTEGER NOT NULL DEFAULT 0")
    conn.execute("CREATE TABLE IF NOT EXISTS subjects (name TEXT PRIMARY KEY, ord INTEGER)")
    conn.execute("CREATE TABLE IF NOT EXISTS children (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL)")


def init_db():
    conn = db()
    migrate(conn)
    for i, s in enumerate(DEFAULT_SUBJECTS):
        conn.execute("INSERT OR IGNORE INTO subjects VALUES (?,?)", (s, i))
        conn.execute("UPDATE subjects SET ord=? WHERE name=?", (i, s))
    conn.execute("UPDATE subjects SET ord=99 WHERE name NOT IN (?,?,?,?,?,?,?,?)", tuple(DEFAULT_SUBJECTS))
    conn.commit()
    if conn.execute("SELECT COUNT(*) FROM subjects").fetchone()[0] == 0:
        for i, s in enumerate(DEFAULT_SUBJECTS):
            conn.execute("INSERT OR IGNORE INTO subjects VALUES (?,?)", (s, i))
        for (s,) in conn.execute("SELECT DISTINCT subject FROM items"):
            conn.execute("INSERT OR IGNORE INTO subjects VALUES (?,?)", (s, 99))
    conn.commit()
    conn.close()


def all_items():
    conn = db()
    rows = conn.execute(
        "SELECT * FROM items ORDER BY pinned DESC, created DESC, id DESC").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_item(item_id):
    conn = db()
    row = conn.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def get_subjects():
    conn = db()
    rows = conn.execute("SELECT name FROM subjects ORDER BY ord, name").fetchall()
    conn.close()
    out = [r[0] for r in rows]
    return out or list(DEFAULT_SUBJECTS)


def get_children():
    conn = db()
    rows = conn.execute("SELECT id, name FROM children ORDER BY id").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def ensure_subject(name):
    name = (name or "").strip() or "其他"
    conn = db()
    conn.execute("INSERT OR IGNORE INTO subjects VALUES (?,99)", (name,))
    conn.commit()
    conn.close()
    return name


def child_name(children, child_id):
    for c in children:
        if c["id"] == child_id:
            return c["name"]
    return ""


def visible_items(items):
    now = now_dt()
    return [i for i in items if not i["visible_at"] or i["visible_at"] <= now]


def filter_child(items, child_id):
    if not child_id:
        return items
    return [i for i in items if i.get("child_id", 0) in (0, child_id)]


def admin_token():
    return hashlib.sha256(ADMIN_PASSWORD.encode()).hexdigest()


def is_admin(handler):
    cookie = handler.headers.get("Cookie", "")
    for part in cookie.split(";"):
        if part.strip().startswith("admin=") and part.strip()[6:] == admin_token():
            return True
    return False


def parse_urlencoded(handler, length):
    raw = handler.rfile.read(length).decode("utf-8", "replace")
    return {k: v[0] for k, v in parse_qs(raw).items()}, None, None


def decode_filename(raw):
    """多部分里的 filename：优先 filename*=UTF-8 编码，其次按 UTF-8 解码，
    中文文件名不要再被替换成下划线。"""
    m = re.search(br"filename\*=([^;\r\n]+)", raw)
    if m:
        v = m.group(1).strip().strip(b'"').decode("ascii", "replace")
        if "''" in v:
            return unquote(v.split("''", 1)[1])
        return unquote(v)
    m = re.search(br'filename="([^"]*)"', raw)
    if not m:
        return ""
    b = m.group(1)
    try:
        return b.decode("utf-8")
    except UnicodeDecodeError:
        return b.decode("latin-1")


def parse_multipart(handler, length, ctype):
    m = re.search(r"boundary=([^;]+)", ctype or "")
    if not m:
        return {}, None, None
    boundary = b"--" + m.group(1).strip().strip('"').encode()
    body = handler.rfile.read(length)
    fields, file_bytes, filename = {}, None, ""
    for part in body.split(boundary):
        if b"\r\n\r\n" not in part:
            continue
        head, content = part.split(b"\r\n\r\n", 1)
        if content.endswith(b"\r\n"):
            content = content[:-2]
        if content.endswith(b"--"):
            content = content[:-2]
        dm = re.search(br'name="([^"]+)"', head)
        if not dm:
            continue
        name = dm.group(1).decode()
        fn = decode_filename(head)
        if fn:
            file_bytes, filename = content, fn
        else:
            fields[name] = content.decode("utf-8", "replace")
    return fields, file_bytes, filename


def original_filename(name):
    """只做路径清理，保留中文、空格和原扩展名，显示和下载都用这个。"""
    name = (name or "").replace("\\", "/").split("/")[-1].strip()
    return name[:120] if name else ""


def stored_name(original):
    ext = os.path.splitext(original)[1].lower()
    ext = re.sub(r"[^a-z0-9.]", "", ext)[:10]
    return secrets.token_hex(8) + ext


def create_item(fields, file_bytes, filename):
    """标题不填就用文件名（去掉扩展名）；没文件也没标题就用正文开头或“未命名”。"""
    original = original_filename(filename)
    stem = os.path.splitext(original)[0].strip()
    title = (fields.get("title") or "").strip()
    if not title:
        title = stem or (fields.get("body") or "").strip().split("\n")[0][:30].strip() or "未命名"
    subject = (fields.get("subject_new") or "").strip() or (fields.get("subject") or "").strip() or "其他"
    subject = ensure_subject(subject)
    try:
        child_id = int(fields.get("child_id") or fields.get("child") or 0)
    except ValueError:
        child_id = 0
    stored, mime = "", ""
    if file_bytes:
        stored = stored_name(original)
        with open(os.path.join(UPLOAD_DIR, stored), "wb") as f:
            f.write(file_bytes)
        mime = mimetypes.guess_type(original)[0] or ""
    kind = (fields.get("kind") or "").strip()
    if not kind:
        ext = os.path.splitext(original)[1].lower()
        if mime.startswith("audio/") or ext in (".mp3", ".m4a", ".wav", ".aac", ".ogg", ".flac"):
            kind = "listening"
        elif mime == "application/pdf" or ext == ".pdf":
            kind = "material"
        else:
            kind = "notice"
    conn = db()
    cur = conn.execute(
        "INSERT INTO items (title,subject,kind,body,link_url,filename,stored,mime,"
        "created,due,visible_at,pinned,child_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (title, subject, kind,
         fields.get("body", ""), safe_link(fields.get("link_url", "")),
         original, stored, mime, now_dt(), fields.get("due", ""),
         fields.get("visible_at", ""), 1 if fields.get("pinned") else 0, child_id))
    item_id = cur.lastrowid
    conn.commit()
    conn.close()
    return item_id, title


def subject_meta(name):
    return SUBJECT_META.get(name, ("📁", "#f2f4f7", "#5f6b7a"))


CSS = """
*{box-sizing:border-box}body{font-family:-apple-system,PingFang SC,Hiragino Sans GB,Noto Sans SC,Microsoft YaHei,sans-serif;
max-width:1240px;margin:0 auto;padding:16px;color:#2b2b2b;line-height:1.65;
background:#f4f5f7;font-size:17px}a{color:#2f66c4;text-decoration:none}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid #2f66c4;outline-offset:2px}
.card,button,.chips a{transition:box-shadow 150ms ease,transform 150ms ease}
@media(hover:hover){.card:hover{box-shadow:0 3px 10px rgba(0,0,0,.08)}}
@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
.skip{position:absolute;left:-9999px}.skip:focus{left:16px;top:16px;background:#fff;padding:12px 16px;border-radius:12px;z-index:20}
.empty{text-align:center;padding:24px 16px;color:#777}
.empty .big{font-size:36px}
button:disabled{opacity:.6;cursor:wait}
h1{font-size:24px;margin:8px 0 4px}h2{font-size:20px;margin:0}h3{font-size:18px;margin:0 0 8px}
.topnav{display:flex;justify-content:flex-end;gap:6px;padding:2px 0 8px;font-size:15px;color:#777}.topnav a{color:#777}
.admin-bar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:10px 0;border-bottom:1px solid #e8e8e8;margin-bottom:12px}
.admin-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:12px}
.admin-panel{background:#fff;border:1px solid #e8e8e8;border-radius:16px;padding:14px}
.admin-panel h3{margin-bottom:8px}
.inline-form{display:flex;gap:8px;align-items:center;margin-bottom:8px}
.inline-form input{flex:1;margin:0}.inline-form button{flex-shrink:0}
.arow{display:flex;gap:8px;align-items:center;padding:7px 0;border-top:1px solid #f0f0f0}
.arow:first-of-type{border-top:0}
.arow .t{flex:1;min-width:0}.arow .t a{color:#222}
@media(max-width:700px){.admin-grid{grid-template-columns:1fr}}
.card{background:#fff;border:1px solid #e8e8e8;border-radius:20px;
padding:16px;margin:14px 0;box-shadow:0 1px 3px rgba(0,0,0,.05)}
.tag{display:inline-block;font-size:13px;background:#eef2f8;border-radius:999px;padding:3px 10px;margin-right:6px}
.tag.pin{background:#fff3c4}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}
.chips a,.chip{display:inline-flex;align-items:center;min-height:44px;padding:0 16px;border-radius:999px;
background:#fff;border:1px solid #ddd;color:#333;font-size:16px}
.chips a.on{background:#2f66c4;color:#fff;border-color:#2f66c4}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
.listgrid{display:grid;grid-template-columns:1fr;gap:12px}
.subject{border-top:6px solid #ccc}
.subject .head{display:flex;gap:12px;align-items:center}
.subject .icon{width:52px;height:52px;border-radius:16px;display:flex;align-items:center;
justify-content:center;font-size:26px;flex-shrink:0}
.subject h2{font-size:20px}.subject .sub{color:#777;font-size:14px;margin-top:2px}
.row{display:flex;gap:10px;align-items:flex-start;padding:11px 0;border-top:1px solid #f0f0f0}
.row:first-of-type{border-top:0}.row .t{flex:1;min-width:0}
.row .t a{color:#222;font-size:16px;line-height:1.5;display:block}
.row .meta{color:#888;font-size:13px;margin-top:2px}
.formgrid{display:grid;grid-template-columns:1fr 1fr;gap:0 16px}
input,select,textarea{font-size:17px;padding:13px;width:100%;box-sizing:border-box;margin:8px 0;
border:1px solid #ddd;border-radius:12px;background:#fff}
button,.btn{display:inline-flex;align-items:center;justify-content:center;min-height:48px;
font-size:17px;padding:0 20px;border:0;border-radius:14px;background:#2f66c4;color:#fff;cursor:pointer}
button.danger,.btn.danger{background:#b94a48}button.done{background:#2e7d32}
button.ghost{background:#eef2f8;color:#2f66c4}button.small{min-height:40px;font-size:15px;padding:0 14px}
button.full{width:100%}.muted{color:#777;font-size:14px}
.timer{font-size:44px;text-align:center;margin:8px 0;font-variant-numeric:tabular-nums}
.progress{height:10px;background:#eee;border-radius:999px;overflow:hidden;margin:10px 0}
.progress i{display:block;height:100%;background:#7fb069;border-radius:999px}
audio,embed,img{max-width:100%}audio{width:100%}
.back{display:inline-flex;min-height:48px;align-items:center;padding:0 18px;background:#fff;
border:1px solid #ddd;border-radius:999px;font-size:16px}
input[type=radio]{width:auto;accent-color:#2f66c4}
input[type=checkbox]{width:22px;height:22px;accent-color:#2e7d32}
.bottomnav{display:none}
@media(max-width:700px){
 body{padding:12px 12px 96px;font-size:17px}.grid{grid-template-columns:1fr;gap:12px}
 .formgrid{grid-template-columns:1fr}.card{padding:14px;border-radius:18px}
 .bottomnav{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:10;background:#fff;
  border-top:1px solid #ddd;padding:6px 8px calc(6px + env(safe-area-inset-bottom))}
 .bottomnav a{flex:1;text-align:center;padding:12px 0;font-size:16px;color:#333}
 .bottomnav a span{display:block;font-size:22px}
}
:root{color-scheme:light}
.binder{display:flex;align-items:stretch;gap:0;margin-top:12px;background:#fff;
border:1px solid #e8e8e8;border-radius:20px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.05)}
.binder-tabs{display:flex;flex-direction:column;gap:0;width:176px;flex-shrink:0;background:#f0f2f5}
.binder-tab{display:flex;align-items:center;gap:8px;min-height:56px;padding:12px;border:0;
border-bottom:1px solid #e8e8e8;border-left:6px solid transparent;color:#333;background:transparent}
.binder-tab:last-child{border-bottom:0}
.binder-tab.on{background:#fff;font-weight:700}
.binder-tab .n{flex:1;min-width:0}.binder-tab .cnt{font-size:13px;color:#777;background:#eef2f8;
border-radius:999px;padding:2px 8px;flex-shrink:0}
.spine{width:30px;flex-shrink:0;background:#fff;border-right:1px solid #eee;display:flex;
flex-direction:column;justify-content:space-evenly;align-items:center;padding:20px 0}
.spine i{width:14px;height:14px;border-radius:50%;background:#f4f5f7;border:2px solid #ddd;display:block}
.binder-pane{flex:1;min-width:0;background:#fff;padding:20px}
.binder-pane .row{padding:8px 0}
.binder.opening{animation:bookopen 650ms cubic-bezier(.22,.9,.3,1);transform-origin:left center}
@keyframes bookopen{from{transform:perspective(1000px) rotateY(-14deg) translateX(-10px);opacity:.5}to{transform:none;opacity:1}}
.notebooks{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:12px}
.notebook{display:block;background:#fff;border:1px solid #e8e8e8;border-left:14px solid #2f66c4;
border-radius:20px;padding:22px;box-shadow:0 1px 3px rgba(0,0,0,.05);color:#222;
transition:transform 300ms ease,box-shadow 300ms ease}
.notebook.opening{transform:perspective(800px) rotateY(-8deg) scale(1.02);box-shadow:0 8px 20px rgba(0,0,0,.12)}
.notebook h2{font-size:22px}.notebook .sub{color:#777;font-size:15px;margin-top:6px}
@media(min-width:701px){.binder{align-items:stretch}.binder-pane{max-height:calc(100dvh - 150px);overflow-y:auto}}
@media(max-width:700px){
 .binder{flex-direction:column}.binder-tabs{flex-direction:row;overflow-x:auto;width:auto;background:#f0f2f5}
 .binder-tab{border-bottom:0;border-right:1px solid #e8e8e8;min-width:116px;flex-shrink:0}
 .binder-tab.on{background:#fff}.spine{display:none}.binder-pane{padding:16px}
 .notebooks{grid-template-columns:1fr}
}
@media(prefers-reduced-motion:reduce){.binder.opening,.notebook{animation:none!important;transition:none!important}}
@media(min-width:900px){.listgrid{grid-template-columns:1fr 1fr}}
"""


def page(title, body):
    return ("<!DOCTYPE html><html lang='zh-CN'><head><meta charset='utf-8'>"
            "<meta name='viewport' content='width=device-width,initial-scale=1'>"
            f"<title>{esc(title)}</title><style>{CSS}</style>"
            "<link rel='manifest' href='/manifest.json'>"
            "<link rel='icon' type='image/png' sizes='192x192' href='/icon-192.png'>"
            "<link rel='apple-touch-icon' href='/apple-touch-icon.png'>"
            "<meta name='theme-color' content='#2f66c4'>"
            "<meta name='apple-mobile-web-app-capable' content='yes'>"
            "<meta name='apple-mobile-web-app-title' content='登记簿'>"
            "<meta name='apple-mobile-web-app-status-bar-style' content='default'></head><body>"
            "<a class='skip' href='#main'>跳到内容</a>"
            "<nav class='topnav' aria-label='顶部导航'><a href='/'>首页</a> ｜ <a href='/register'>登记</a> ｜ <a href='/admin'>管理</a></nav>"
            f"<main id='main'>{body}</main>"
            "<nav class='bottomnav' aria-label='底部导航'><a href='/'><span>🏠</span>首页</a>"
            "<a href='/register'><span>✏️</span>登记</a>"
            "<a href='/admin'><span>⚙️</span>管理</a></nav>"
            "<script>if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js').catch(function(){});}"
            "document.querySelectorAll('form').forEach(function(f){"
            "f.addEventListener('submit',function(){var b=f.querySelector('button');"
            "if(b&&!b.disabled){b.disabled=true;b.dataset.t=b.textContent;b.textContent='处理中…';}});});</script>"
            "</body></html>").encode()


def error_page(title, msg):
    return page(title, f"<div class='card empty'><div class='big'>😕</div><h3>{esc(title)}</h3>"
                       f"<p class='muted'>{esc(msg)}</p>"
                       "<p><a class='back' href='/'>← 回首页</a> "
                       "<a class='back' href='/register'>去登记</a></p></div>")


def empty_state(text, action=""):
    return (f"<div class='card empty'><div class='big'>📭</div><p>{esc(text)}</p>{action}</div>")


def qs(child=0, **kw):
    parts = []
    if child:
        parts.append(f"child={child}")
    for k, v in kw.items():
        if v:
            parts.append(f"{k}={quote(str(v))}")
    return ("?" + "&".join(parts)) if parts else ""


def compact_row(it, child=0):
    kind = KINDS.get(it["kind"], it["kind"])
    meta = kind + (f" · 截止 {esc(it['due'])}" if it["due"] else "")
    if it["kind"] == "homework" and it["done"]:
        meta += " · ✅ 已完成"
    done_btn = ""
    if it["kind"] == "homework" and not it["done"]:
        done_btn = (f"<form method='post' action='/done' style='margin:0'>"
                    f"<input type='hidden' name='id' value='{it['id']}'>"
                    f"<button class='done small' aria-label='标为已完成：{esc(it['title'])}'>✓ 完成</button></form>")
    return (f"<div class='row'><div class='t'><a href='/item?id={it['id']}{('&child=' + str(child)) if child else ''}'>{esc(it['title'])}</a>"
            f"<div class='meta'>{meta}</div></div>{done_btn}</div>")


def item_card(it, children, detail=False, child=0):
    kind = KINDS.get(it["kind"], it["kind"])
    tags = f"<span class='tag'>{esc(it['subject'])}</span><span class='tag'>{kind}</span>"
    cn = child_name(children, it.get("child_id", 0))
    if cn:
        tags += f"<span class='tag'>{esc(cn)}</span>"
    if it["pinned"]:
        tags += "<span class='tag pin'>置顶</span>"
    if it["due"]:
        tags += f"<span class='tag'>截止 {esc(it['due'])}</span>"
    if it["kind"] == "homework" and it["done"]:
        tags += "<span class='tag'>✅ 已完成</span>"
    out = f"<div class='card'>{tags}<h3 style='margin:8px 0'>{esc(it['title'])}</h3>"
    if it["body"]:
        out += f"<p>{esc(it['body']).replace(chr(10), '<br>')}</p>"
    link = safe_link(it["link_url"])
    if link:
        out += (f"<p><a href='{esc(link)}' target='_blank' rel='noopener'>"
                "🔗 打开原链接（扫描全能王等）</a></p>")
    if it["stored"]:
        url = "/uploads/" + quote(it["stored"])
        mime = it["mime"] or ""
        if mime.startswith("image/"):
            out += f"<p><img src='{url}' alt='{esc(it['filename'])}'></p>"
        elif mime.startswith("audio/"):
            out += (f"<p><audio controls src='{url}' id='au'></audio><br>"
                    "速度：<select onchange=\"document.getElementById('au').playbackRate=this.value\">"
                    "<option value='0.75'>0.75×</option><option value='1' selected>1×</option>"
                    "<option value='1.25'>1.25×</option></select> "
                    "<label><input type='checkbox' style='width:auto' "
                    "onchange=\"document.getElementById('au').loop=this.checked\"> 循环播放</label></p>")
        elif mime == "application/pdf" or it["filename"].lower().endswith(".pdf"):
            out += f"<p><embed src='{url}' type='application/pdf' width='100%' height='600'></p>"
        out += f"<p><a href='{url}?download=1'>⬇ 下载：{esc(it['filename'])}</a></p>"
    if it["kind"] == "homework":
        label = "↩ 取消完成" if it["done"] else "✅ 标为已完成"
        cls = "" if it["done"] else "done"
        out += (f"<form method='post' action='/done'><input type='hidden' name='id' value='{it['id']}'>"
                f"<button class='{cls}'>{label}</button></form>")
    if not detail:
        out += f"<p><a href='/item?id={it['id']}'>打开详情 →</a></p>"
    return out + "</div>"


def is_today(it):
    return it["pinned"] or it["due"] == today() or it["created"][:10] == today()


def timer_card():
    return """<div class='card'><h3>⏱ 专注一下</h3>
<div class='timer' id='t'>25:00</div>
<p style='text-align:center'><button onclick='start()'>开始</button>
<button class='ghost' onclick='stop()'>暂停</button> <button class='ghost' onclick='reset()'>重置</button></p>
<script>let s=1500,timer=null;function show(){document.getElementById('t').textContent=
String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0')}
function start(){if(timer)return;timer=setInterval(()=>{if(s>0){s--;show()}else{stop();alert('时间到，休息一下！')}},1000)}
function stop(){clearInterval(timer);timer=null}
function reset(){stop();s=1500;show()}</script></div>"""


def child_chips(children, child, view=""):
    if not children:
        return ""
    links = [f"<a class='{'on' if child == 0 else ''}' href='/{qs(0, view=view)}'>全部</a>"]
    for c in children:
        links.append(f"<a class='{'on' if child == c['id'] else ''}' href='/{qs(c['id'], view=view)}'>{esc(c['name'])}</a>")
    return "<div class='chips'>" + "".join(links) + "</div>"


def binder_tabs(subjects, per_subject, active, child, view):
    """活页夹标签：封面“今天” + 每门一页，标签上带该门的条数，点标签就是翻页。
    标签和纸面共用一个外框，活动标签背景就是纸面白，中间没有双边框、没有错位圆角。"""
    tabs = [f"<a role='tab' aria-selected='{str(active == '').lower()}' class='binder-tab{' on' if not active else ''}' "
            f"href='/{qs(child, view=view)}'><span>📕</span><span class='n'>今天</span></a>"]
    for s in subjects:
        icon, bg, color = subject_meta(s)
        n = len(per_subject.get(s, []))
        if n == 0 and active != s:
            continue
        tabs.append(f"<a role='tab' aria-selected='{str(active == s).lower()}' "
                    f"class='binder-tab{' on' if active == s else ''}' style='border-left:6px solid {color}' "
                    f"href='/{qs(child, subject=s, view=view)}'><span>{icon}</span><span class='n'>{esc(s)}</span>"
                    f"<span class='cnt'>{n}</span></a>")
    return "<div class='binder-tabs' role='tablist' aria-label='学科活页夹'>" + "".join(tabs) + "</div>"


def binder_wrap(tabs, pane, opening=False):
    spine = "<div class='spine' aria-hidden='true'><i></i><i></i><i></i><i></i><i></i></div>"
    cls = "binder opening" if opening else "binder"
    return f"<div class='{cls}'>{tabs}{spine}<div class='binder-pane'>{pane}</div></div>"


def notebook_covers(children, items):
    """多孩时先选本子：每本一个大封面，点开带翻书动画；单孩/无孩不走这页，直接进活页夹。"""
    colors = ["#2f66c4", "#2e7d5b", "#c2702e", "#6a4fc4", "#b94a48"]
    cards = ""
    for i, c in enumerate(children):
        mine = [x for x in items if x.get("child_id") == c["id"]]
        hw = [x for x in mine if x["kind"] == "homework"]
        done = sum(1 for x in hw if x["done"])
        color = colors[i % len(colors)]
        cards += (f"<a class='notebook' style='border-left-color:{color}' href='/?child={c['id']}'>"
                  f"<div style='font-size:36px'>📓</div><h2>{esc(c['name'])}的作业登记簿</h2>"
                  f"<div class='sub'>{len(mine)} 条内容 · 作业完成 {done} / {len(hw)}</div></a>")
    script = ("<script>document.querySelectorAll('.notebook').forEach(function(a){"
              "a.addEventListener('click',function(e){e.preventDefault();a.classList.add('opening');"
              "setTimeout(function(){location.href=a.href;},300);});});</script>")
    return f"<div class='notebooks'>{cards}</div>" + script


def timer_details():
    # 标题只在 summary 里出现一次，展开后不再重复一个“专注一下”
    inner = timer_card().replace("<div class='card'>", "<div>", 1).replace("<h3>⏱ 专注一下</h3>", "", 1)
    return f"<details style='margin-top:12px'><summary style='cursor:pointer;min-height:48px;display:flex;align-items:center'>⏱ 专注一下（点开计时）</summary>{inner}</details>"


def add_form(subjects, children, action="/add", preselect_subject="", preselect_child=0, show_extra=True):
    subj_chips = "".join(
        f"<label class='chip'><input type='radio' name='subject' value='{esc(s)}' "
        f"{'checked' if s == (preselect_subject or '语文') else ''}> {esc(s)}</label>" for s in subjects)
    kind_chips = "".join(
        f"<label class='chip'><input type='radio' name='kind' value='{k}' "
        f"{'checked' if k == 'notice' else ''}> {v}</label>" for k, v in KINDS.items())
    child_radios = ""
    if children:
        child_radios = ("<p class='muted' style='margin:8px 0 0'>给谁</p><div class='chips'>"
                        f"<label class='chip'><input type='radio' name='child_id' value='0' {'checked' if not preselect_child else ''}> 全部</label>" +
                        "".join(f"<label class='chip'><input type='radio' name='child_id' value='{c['id']}' "
                                f"{'checked' if preselect_child == c['id'] else ''}> {esc(c['name'])}</label>"
                                for c in children) + "</div>")
    extra = ""
    if show_extra:
        extra = ("<label class='muted'>到这个时间才显示（答案类建议填）</label>"
                 "<input type='datetime-local' name='visible_at'>"
                 "<label style='display:flex;gap:10px;align-items:center;min-height:48px'>"
                 "<input type='checkbox' name='pinned'> 置顶提醒</label>")
    return (f"<form method='post' action='{action}' enctype='multipart/form-data'>"
            "<input name='title' aria-label='标题，不填就用文件名' placeholder='标题（不填就用文件名）'>"
            f"<p class='muted' style='margin:8px 0 0'>学科</p><div class='chips'>{subj_chips}</div>"
            f"<p class='muted' style='margin:8px 0 0'>类型</p><div class='chips'>{kind_chips}</div>"
            f"{child_radios}"
            "<div class='formgrid'><div><label class='muted'>截止日期（作业用）</label><input type='date' name='due'></div>"
            "<div><label class='muted'>原链接（扫描全能王等，可空）</label><input name='link_url' placeholder='https://…'></div></div>"
            "<textarea name='body' rows='4' placeholder='文字内容（通知正文，没有文件时就填这里）'></textarea>"
            f"{extra}"
            "<label class='muted'>上传文件（PDF / 图片 / MP3，最大 50MB，中文文件名会原样保留）</label>"
            "<input type='file' name='file'><button class='full'>登记</button></form>")


def kid_page(params):
    try:
        child = int(params.get("child", ["0"])[0])
    except ValueError:
        child = 0
    subject = params.get("subject", [""])[0]
    view = "all"
    q = params.get("q", [""])[0].strip()
    children = get_children()
    items = filter_child(visible_items(all_items()), child)
    hidden = len(filter_child(all_items(), child)) - len(items)
    subjects = get_subjects()
    hw = [i for i in items if i["kind"] == "homework"]
    hw_today = [i for i in hw if i["due"] == today() or not i["due"]]
    done_n = sum(1 for i in hw_today if i["done"])
    pct = int(done_n * 100 / len(hw_today)) if hw_today else 100
    progress = (f"<div class='card'><h3>今天的进度</h3>"
                f"<div class='progress'><i style='width:{pct}%'></i></div>"
                f"<p class='muted' style='margin:0'>已完成 {done_n} / {len(hw_today)} 项作业"
                f"{' · 做完啦，休息一下吧 🌿' if hw_today and done_n == len(hw_today) else ''}"
                f"{' · 还有 ' + str(hidden) + ' 条内容未到显示时间' if hidden else ''}</p></div>")
    per_subject = {}
    for s in subjects:
        per_subject[s] = [i for i in items if i["subject"] == s]
    tabs = binder_tabs(subjects, per_subject, subject, child, view)
    if subject:
        shown = [i for i in items if i["subject"] == subject]
        if q:
            shown = [i for i in shown if q in i["title"] or q in i["body"]]
        icon, bg, color = subject_meta(subject)
        pane = (f"<div class='head' style='display:flex;gap:12px;align-items:center'>"
                f"<div class='icon' style='width:52px;height:52px;border-radius:16px;display:flex;align-items:center;justify-content:center;font-size:26px;background:{bg}'>{icon}</div>"
                f"<div><h2>{esc(subject)}</h2><div class='sub'>{len(shown)} 条 · "
                f"作业完成 {sum(1 for i in shown if i['kind'] == 'homework' and i['done'])}"
                f" / {sum(1 for i in shown if i['kind'] == 'homework')}</div></div></div>"
                + "".join(compact_row(i, child) for i in shown) +
                (empty_state("这门今天没有新内容，去登记一条吧。",
                             f"<p><a class='back' href='/register?subject={quote(subject)}'>去登记{esc(subject)}</a></p>") if not shown else "") +
                f"<form method='get'><input name='q' aria-label='在这门里搜索' placeholder='在这门里搜' value='{esc(q)}'>"
                f"<input type='hidden' name='subject' value='{esc(subject)}'>"
                f"<input type='hidden' name='view' value='{esc(view)}'>"
                f"<input type='hidden' name='child' value='{child}'><button>搜索</button></form>")
        body = binder_wrap(tabs, pane, opening=True)
        return page(f"{subject} - 作业板", body)
    pins = [i for i in items if i["kind"] == "announcement" and i["pinned"]][:2]
    # 封面页：只放进度、提醒、各科计数，点标签翻页，不把各科内容全堆在一屏下拉。
    if q:
        shown = [i for i in items if q in i["title"] or q in i["body"]]
        pane = (f"<h2>搜索“{esc(q)}”</h2>" + "".join(compact_row(i, child) for i in shown) +
                (empty_state(f"没搜到“{q}”，换个词试试，或者去登记一条。",
                             "<p><a class='back' href='/'>← 回首页</a></p>") if not shown else ""))
        body = binder_wrap(tabs, pane, opening=True)
        return page("作业板", body)
    # 多孩且还没选本子：先看本子封面，不直接进活页夹；没有“不分本子看全部”这个需求
    if len(children) > 1 and not child and not subject:
        return page("选本子 - 作业板", notebook_covers(children, visible_items(all_items())))
    pane = (f"<h3>今天的进度</h3><div class='progress'><i style='width:{pct}%'></i></div>"
            f"<p class='muted' style='margin:0 0 12px'>已完成 {done_n} / {len(hw_today)} 项作业"
            f"{' · 做完啦，休息一下吧 🌿' if hw_today and done_n == len(hw_today) else ''}"
            f"{' · 还有 ' + str(hidden) + ' 条内容未到显示时间' if hidden else ''}</p>")
    if pins:
        pane += ("<h3 style='margin-top:12px'>📌 提醒</h3>" +
                 "".join(f"<p style='margin:6px 0'><a href='/item?id={i['id']}{('&child=' + str(child)) if child else ''}'>{esc(i['title'])}</a></p>"
                         for i in pins))
    pane += "<h3 style='margin-top:12px'>各科</h3>"
    for s in subjects:
        sub = per_subject.get(s, [])
        if not sub:
            continue
        icon, bg, color = subject_meta(s)
        hw_s = [i for i in sub if i["kind"] == "homework"]
        sub_line = (f"作业 {sum(1 for i in hw_s if i['done'])} / {len(hw_s)}"
                    if hw_s else f"{len(sub)} 条")
        pane += (f"<div class='row'><div class='t'><a href='/{qs(child, subject=s, view=view)}'>{icon} {esc(s)}</a>"
                 f"<div class='meta'>{sub_line}</div></div>"
                 f"<a class='back' style='min-height:40px' href='/{qs(child, subject=s, view=view)}'>翻页 →</a></div>")
    pane += (f"<form method='get'><input name='q' aria-label='搜索全部标题和内容' placeholder='搜全部标题 / 内容' value='{esc(q)}'>"
             f"<input type='hidden' name='view' value='{esc(view)}'>"
             f"<input type='hidden' name='child' value='{child}'><button>搜索</button></form>"
             + timer_details())
    body = binder_wrap(tabs, pane, opening=True)
    return page("作业板", body)


def register_page(msg="", preselect_subject="", preselect_child=0):
    subjects, children = get_subjects(), get_children()
    api_help = """<details class='card'><summary style='cursor:pointer;min-height:48px;display:flex;align-items:center'>curl / iPhone 捷径上传（点开看）</summary>
<p class='muted'>下面把 HOST 换成这台服务器的地址，例如 HOST:8765（换成你这台服务器的地址）。</p>
<pre style='white-space:pre-wrap;word-break:break-all;font-size:14px'># 取孩子和学科列表（给捷径做下拉）：GET http://HOST/api/lists
# 返回 {"children": [{"id": 0, "name": "全部"}, ...], "subjects": ["语文", ...]}
# 传一个文件，标题不填就用文件名；kind 不填时音频自动是听力、PDF 自动是学习资料
curl -F "file=@/path/数学练习.pdf" -F "subject=数学" http://HOST/api/items

# 只传文字 / 链接
curl -d "title=本周通知&subject=语文&body=周五听写" http://HOST/api/items</pre>
<p>iPhone 捷径做法：分享菜单 → 新建捷径 → 接收“文件/图像/PDF”→
先“获取 URL 内容” GET http://HOST/api/lists，取字典里的 subjects 和 children
各做一个“从列表中选取”（孩子选 id、学科选名字），再“获取 URL 内容”选 POST、
表单，地址填 http://HOST/api/items，表单里 file=捷径输入、subject=上一步选的学科、
child_id=上一步选的孩子 id；kind 不用填，MP3 这类音频自动是听力、PDF 自动是学习资料，
想指定类型时再填 kind（notice/homework/material/answer/listening/announcement）；
再把这个捷径加到分享菜单，以后在微信里长按文件 → 分享 → 这个捷径，
一步就登记进来了，不用先存文件再打开网页。手机须和服务器在同一局域网，
或都连着 Tailscale。</p>
<p class='muted'>这个接口只在局域网 / Tailscale 内可信，没有对外公开；
如需加口令，部署时设 API_TOKEN，请求再带 X-API-Token 头。</p></details>"""
    body = (f"{f'<p><b>{esc(msg)}</b></p>' if msg else ''}"
            "<div class='card'><h3>登记作业 / 通知</h3>"
            "<p class='muted'>谁都可以登记，不需要密码；标题不填就用文件名。</p>"
            + add_form(subjects, children, "/add", preselect_subject, preselect_child) + "</div>"
            + api_help +
            "<p><a class='back' href='/'>← 回首页</a> <a class='back' href='/admin'>去管理</a></p>")
    return page("登记 - 作业板", body)


def admin_page(msg=""):
    """管理页紧凑版：摘要只一行、孩子/学科双栏并排、每条只一行，
    不再放登记表单（登记只走登记页），不再一卡一卡往下堆，
    也不再把退出按钮藏到最底下。"""
    items, subjects, children = all_items(), get_subjects(), get_children()
    hw = [i for i in items if i["kind"] == "homework"]
    done_n = sum(1 for i in hw if i["done"])
    rows = ""
    for it in items:
        gated = it["visible_at"] and it["visible_at"] > now_dt()
        cn = child_name(children, it.get("child_id", 0))
        meta = f"{esc(it['subject'])} · {KINDS.get(it['kind'], '')}"
        if cn:
            meta += f" · {esc(cn)}"
        if gated:
            meta += " · ⏳ 未到显示时间"
        if it['kind'] == 'homework' and it['done']:
            meta += " · ✅ 已完成"
        rows += (f"<div class='arow'><div class='t'><a href='/item?id={it['id']}'>{esc(it['title'])}</a>"
                 f"<div class='meta'>{meta}</div></div>"
                 f"<form method='post' action='/admin/delete' style='margin:0'>"
                 f"<input type='hidden' name='id' value='{it['id']}'>"
                 "<button class='danger small'>删除</button></form></div>")
    child_rows = ""
    for c in children:
        n = sum(1 for i in items if i.get("child_id") == c["id"])
        child_rows += (f"<div class='arow'>"
                       f"<form class='inline-form' style='flex:1;margin:0' method='post' action='/admin/child/rename'>"
                       f"<input type='hidden' name='id' value='{c['id']}'>"
                       f"<input name='name' value='{esc(c['name'])}' aria-label='孩子名字，改了点改名' required>"
                       f"<span class='meta' style='white-space:nowrap'>{n} 条</span>"
                       "<button class='small'>改名</button></form>"
                       f"<form method='post' action='/admin/child/delete' style='margin:0'>"
                       f"<input type='hidden' name='id' value='{c['id']}'>"
                       "<button class='danger small'>删除</button></form></div>")
    subj_rows = ""
    for s in subjects:
        n = sum(1 for i in items if i["subject"] == s)
        del_btn = (f"<form method='post' action='/admin/subject/delete' style='margin:0'>"
                   f"<input type='hidden' name='name' value='{esc(s)}'>"
                   "<button class='danger small'>删除</button></form>") if n == 0 else ""
        subj_rows += f"<div class='arow'><div class='t'><b>{esc(s)}</b><div class='meta'>{n} 条</div></div>{del_btn}</div>"
    body = (f"<div class='admin-bar'><span>作业完成 {done_n} / {len(hw)}</span>"
            f"<span class='muted'>共 {len(items)} 条 · {len(children)} 个孩子 · {len(subjects)} 门学科</span>"
            f"<span style='flex:1'></span>"
            f"<form method='post' action='/admin/logout' style='margin:0'><button class='ghost small'>退出管理</button></form></div>"
            f"{f'<p><b>{esc(msg)}</b></p>' if msg else ''}"
            "<div class='admin-grid'>"
            "<div class='admin-panel'><h3>孩子</h3>"
            "<form class='inline-form' method='post' action='/admin/child'>"
            "<input name='name' aria-label='孩子名字' placeholder='孩子名字，如：小明' required>"
            "<button>加孩子</button></form>"
            + (child_rows or "<p class='muted'>还没加孩子。</p>") + "</div>"
            "<div class='admin-panel'><h3>学科</h3>"
            "<form class='inline-form' method='post' action='/admin/subject'>"
            "<input name='name' aria-label='新学科' placeholder='新学科，如：道法' required>"
            "<button>加学科</button></form>" + subj_rows + "</div></div>"
            "<h3>已登记内容</h3>" + (rows or "<p>还没有内容。</p>"))
    return page("管理 - 作业板", body)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send_html(self, data, status=200, cookie=None):
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def redirect(self, loc, cookie=None):
        self.send_response(303)
        self.send_header("Location", loc)
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        u = urlparse(self.path)
        params = parse_qs(u.query)
        if u.path in ("/manifest.json", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png", "/icon.svg", "/sw.js"):
            ctype = {"json": "application/manifest+json", "js": "application/javascript",
                     "svg": "image/svg+xml", "png": "image/png"}.get(u.path.rsplit(".", 1)[-1], "image/png")
            try:
                with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), u.path.lstrip("/")), "rb") as f:
                    data = f.read()
            except OSError:
                self.send_response(404)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "public, max-age=86400")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if u.path == "/health":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")
            return
        if u.path == "/":
            self.send_html(kid_page(params))
            return
        if u.path == "/register":
            self.send_html(register_page("", params.get("subject", [""])[0],
                                         int(params.get("child", ["0"])[0] or 0) if params.get("child", ["0"])[0].isdigit() else 0))
            return
        if u.path == "/api/lists":
            self.send_json({"ok": True,
                            "children": [{"id": 0, "name": "全部"}] + [{"id": c["id"], "name": c["name"]} for c in get_children()],
                            "subjects": get_subjects()})
            return
        if u.path == "/api":
            self.send_json({"ok": True, "post": "/api/items",
                            "lists": "/api/lists",
                            "fields": "title(可选，不填用文件名), subject, subject_new, kind(不填时：音频->听力，PDF->学习资料，其余->通知), body, link_url, due, visible_at, pinned, child_id",
                            "example": "curl -F \"file=@数学练习.pdf\" -F \"subject=数学\" http://HOST:8765/api/items"})
            return
        if u.path == "/api/items":
            try:
                child = int(params.get("child", ["0"])[0])
            except ValueError:
                child = 0
            items = filter_child(visible_items(all_items()), child)
            subj = params.get("subject", [""])[0]
            if subj:
                items = [i for i in items if i["subject"] == subj]
            self.send_json({"ok": True, "items": [
                {"id": i["id"], "title": i["title"], "subject": i["subject"], "kind": i["kind"],
                 "body": i["body"], "link_url": i["link_url"], "filename": i["filename"],
                 "file_url": ("/uploads/" + quote(i["stored"])) if i["stored"] else "",
                 "due": i["due"], "done": bool(i["done"]), "child_id": i.get("child_id", 0),
                 "url": f"/item?id={i['id']}"} for i in items]})
            return
        if u.path == "/item":
            try:
                it = get_item(int(params.get("id", ["0"])[0]))
            except ValueError:
                it = None
            if not it or (it["visible_at"] and it["visible_at"] > now_dt()):
                self.send_html(error_page("没找到这条内容", "它可能不存在，或者还没到设定的显示时间。"), 404)
                return
            try:
                child = int(params.get("child", ["0"])[0])
            except ValueError:
                child = 0
            back = (f"<p><a class='back' href='/{qs(child, subject=it['subject'])}'>"
                    f"← 回{esc(it['subject'])}</a></p>")
            self.send_html(page(it["title"], back + item_card(it, get_children(), detail=True, child=child)))
            return
        if u.path == "/admin":
            if not is_admin(self):
                form = ("<div class='card'><h3>管理登录</h3>"
                        "<form method='post' action='/admin/login'>"
                        "<input type='password' name='password' aria-label='管理密码' placeholder='管理密码' required>"
                        "<button class='full'>登录</button></form>"
                        "<p class='muted'>登记不需要密码；删除、加孩子、加学科需要管理密码。"
                        "原型默认密码 admin123，部署前改 ADMIN_PASSWORD。</p></div>")
                self.send_html(page("管理登录", form))
                return
            self.send_html(admin_page())
            return
        if u.path.startswith("/uploads/"):
            name = unquote(urlparse(self.path).path[len("/uploads/"):])
            if "/" in name or ".." in name or not os.path.isfile(os.path.join(UPLOAD_DIR, name)):
                self.send_html(error_page("文件找不到了", "这个附件可能已被删除，回到首页重新找一下。"), 404)
                return
            path = os.path.join(UPLOAD_DIR, name)
            mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
            data = open(path, "rb").read()
            self.send_response(200)
            self.send_header("Content-Type", mime)
            if parse_qs(urlparse(self.path).query).get("download"):
                it = None
                conn = db()
                row = conn.execute("SELECT filename FROM items WHERE stored=?", (name,)).fetchone()
                conn.close()
                if row:
                    it = row[0]
                if it:
                    self.send_header("Content-Disposition",
                                     "attachment; filename*=UTF-8''" + quote(it))
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        self.send_html(error_page("这个页面不存在", "地址可能打错了，回到首页重新找一下。"), 404)

    def read_form(self):
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length > MAX_FILE_BYTES + 1024 * 1024:
            return {}, None, None
        ctype = self.headers.get("Content-Type", "")
        if ctype.startswith("multipart/form-data"):
            return parse_multipart(self, length, ctype)
        if ctype.startswith("application/json"):
            try:
                obj = json.loads(self.rfile.read(length).decode("utf-8"))
                return {k: str(v) for k, v in obj.items()}, None, None
            except Exception:
                return {}, None, None
        return parse_urlencoded(self, length)

    def do_add(self, redirect_to):
        fields, file_bytes, filename = self.read_form()
        item_id, title = create_item(fields, file_bytes, filename)
        if redirect_to == "api":
            return item_id, title
        self.redirect(redirect_to)
        return item_id, title

    def do_POST(self):
        u = urlparse(self.path)
        # 文件过大先拦住，不生成一条空内容：这是出错态，不是静默成功。
        try:
            clen = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            clen = 0
        if u.path in ("/add", "/admin/add", "/api/items") and clen > MAX_FILE_BYTES + 1024 * 1024:
            if u.path == "/api/items":
                self.send_json({"ok": False, "error": "file too large, max 50MB"}, 413)
            else:
                self.send_html(error_page("文件太大了", "单个文件最大 50MB，请压缩或拆分后再登记。"), 413)
            return
        if u.path == "/api/items":
            if API_TOKEN:
                token = self.headers.get("X-API-Token", "") or parse_qs(urlparse(self.path).query).get("token", [""])[0]
                if token != API_TOKEN:
                    self.send_json({"ok": False, "error": "unauthorized"}, 401)
                    return
            fields, file_bytes, filename = self.read_form()
            item_id, title = create_item(fields, file_bytes, filename)
            self.send_json({"ok": True, "id": item_id, "title": title, "url": f"/item?id={item_id}"}, 201)
            return
        fields, file_bytes, filename = self.read_form()
        if u.path == "/done":
            try:
                item_id = int(fields.get("id", "0"))
            except ValueError:
                item_id = 0
            conn = db()
            conn.execute("UPDATE items SET done = 1 - done WHERE id=?", (item_id,))
            conn.commit()
            conn.close()
            ref = urlparse(self.headers.get("Referer", "") or "")
            back = ref.path + ("?" + ref.query if ref.query else "")
            self.redirect(back if back.startswith("/") else "/")
            return
        if u.path == "/admin/login":
            if fields.get("password") == ADMIN_PASSWORD:
                self.redirect("/admin", f"admin={admin_token()}; Path=/; HttpOnly")
            else:
                self.send_html(error_page("密码不对", "管理密码不对，请重试；登记不需要密码。"))
            return
        if u.path == "/admin/logout":
            self.redirect("/admin", "admin=; Path=/; Max-Age=0")
            return
        if u.path in ("/add", "/admin/add"):
            # 登记开放：谁都可以登记；管理页的登记表单也走同一口。
            item_id, title = create_item(fields, file_bytes, filename)
            try:
                child = int(fields.get("child_id") or 0)
            except ValueError:
                child = 0
            self.redirect("/admin" if u.path == "/admin/add" else f"/{qs(child)}")
            return
        if not is_admin(self):
            self.send_response(403)
            self.end_headers()
            return
        if u.path == "/admin/delete":
            try:
                item_id = int(fields.get("id", "0"))
            except ValueError:
                item_id = 0
            it = get_item(item_id)
            if it and it["stored"]:
                try:
                    os.remove(os.path.join(UPLOAD_DIR, it["stored"]))
                except OSError:
                    pass
            conn = db()
            conn.execute("DELETE FROM items WHERE id=?", (item_id,))
            conn.commit()
            conn.close()
            self.redirect("/admin")
            return
        if u.path == "/admin/child":
            name = (fields.get("name") or "").strip()
            if name:
                conn = db()
                conn.execute("INSERT OR IGNORE INTO children (name) VALUES (?)", (name,))
                conn.commit()
                conn.close()
            self.redirect("/admin")
            return
        if u.path == "/admin/child/delete":
            try:
                cid = int(fields.get("id", "0"))
            except ValueError:
                cid = 0
            conn = db()
            conn.execute("UPDATE items SET child_id=0 WHERE child_id=?", (cid,))
            conn.execute("DELETE FROM children WHERE id=?", (cid,))
            conn.commit()
            conn.close()
            self.redirect("/admin")
            return
        if u.path == "/admin/child/rename":
            try:
                cid = int(fields.get("id", "0"))
            except ValueError:
                cid = 0
            name = (fields.get("name") or "").strip()
            if cid and name:
                conn = db()
                try:
                    conn.execute("UPDATE children SET name=? WHERE id=?", (name, cid))
                    conn.commit()
                except sqlite3.IntegrityError:
                    pass
                conn.close()
            self.redirect("/admin")
            return
        if u.path == "/admin/subject":
            name = (fields.get("name") or "").strip()
            if name:
                ensure_subject(name)
            self.redirect("/admin")
            return
        if u.path == "/admin/subject/delete":
            name = (fields.get("name") or "").strip()
            conn = db()
            n = conn.execute("SELECT COUNT(*) FROM items WHERE subject=?", (name,)).fetchone()[0]
            if n == 0:
                conn.execute("DELETE FROM subjects WHERE name=?", (name,))
            conn.commit()
            conn.close()
            self.redirect("/admin")
            return
        self.send_html(error_page("这个操作不存在", "回到首页重新操作一下。"), 404)


if __name__ == "__main__":
    init_db()
    print(f"作业板 http://127.0.0.1:{PORT}/  登记 /register  管理 /admin", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
