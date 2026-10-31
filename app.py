#!/usr/bin/env python3
"""作业板（零依赖，只用 Python 标准库）

浏览：首页一个学科一个块，点学科看这门，点标题看详情。
登记：/register 需要登录，学生仅可登记自己的作业，家长可选择孩子；
      标题不填就用文件名，学科在管理里加，内容可以指定给某个孩子。
管理：/admin 需要密码，只做删除、加孩子、加学科。
API：POST /api/items，curl 和 iPhone 捷径都能直接传文件。
不含微信机器人：收集先走登记上传（之后可再接微信 PC 文件夹监听）。

设计约束（2026-10-27 三条 UI skill 交叉对比后定下，之后改界面先对这条）：
- 只用 1 套风格：Bento 卡片块；只用 1 套柔和配色：底 #f4f5f7、卡片白、
  主色 #2f66c4、完成绿 #2e7d32、删除用暗红；不用玻璃化、黏土化、渐变、着色器。
- 学科展示是活页夹：大屏左侧竖排彩色标签、小屏顶部横滑标签，一次只翻一门；
  封面只放少量待办、提醒、各科计数，学科页只放紧凑标题行，计时器收进可展开，
  目标是一屏看完一页，不靠下拉堆内容。
- 边角协调：活页夹只有一个外框圆角 + overflow 裁剪，标签无间隙、活动标签
  背景就是纸面白、圆孔只在标签与纸面之间的脊柱上，不再各处各圆角；
  顶部不放孩子/今天过滤；多孩先选本子封面（含待办摘要和快捷登记），
  单孩直接进活页夹；用原生链接立即导航，不用延时动画拦截键盘或新标签打开。
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
          API_TOKEN（可选，设了之后 API 须带 X-API-Token 头；管理页也可生成数据库令牌，只存哈希）、
          LLM_API_KEY（可选，不设则 /api/ai-parse 明确返回未配置，改用粘贴 JSON）、
          LLM_BASE_URL（默认 https://api.deepseek.com/v1，OpenAI 兼容）、
          LLM_MODEL（默认 deepseek-chat）、LLM_VISION_MODEL（可选，拍照解析用，默认用 LLM_MODEL）、
          STT_API_KEY（可选，语音转写服务 key，与 LLM 独立配置）、
          STT_BASE_URL（默认 https://api.openai.com/v1，须支持 /audio/transcriptions）、
          STT_MODEL（默认 whisper-1，须支持 multipart + response_format=json）、
          DATA_DIR（默认脚本旁的 data/，Docker 里用 /data）
AI 录入：登记页文字 / 拍照先解析成草稿，逐条核对后经 /api/ai-batch 批量创建，草稿确认前不入库；
        外部 AI 走 /api/lists + /api/items（见 SKILL.md），令牌允许查列表、读取可见内容和创建，不能删除和管理；
        网页与 AI 录入使用会话；外部 API 令牌规则不变。HTTPS 反代部署见 docs/login.md。
数据：SQLite + data/uploads/ 文件，备份时把 data/ 整个拷走即可。
"""
import hmac
from http.cookies import SimpleCookie
from contextlib import contextmanager
from contextvars import ContextVar
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
LLM_API_KEY = os.environ.get("LLM_API_KEY", "")
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "https://api.deepseek.com/v1")
LLM_MODEL = os.environ.get("LLM_MODEL", "deepseek-chat")
LLM_VISION_MODEL = os.environ.get("LLM_VISION_MODEL", "")
# Separate, opt-in speech service: a chat endpoint (e.g. DeepSeek) need not support audio.
STT_API_KEY = os.environ.get("STT_API_KEY", "")
STT_BASE_URL = os.environ.get("STT_BASE_URL", "https://api.openai.com/v1")
STT_MODEL = os.environ.get("STT_MODEL", "whisper-1")
MAX_AUDIO_BYTES = 10 * 1024 * 1024
AUDIO_TYPES = {"audio/webm": "webm", "audio/mp4": "m4a", "audio/m4a": "m4a",
               "audio/x-m4a": "m4a", "audio/ogg": "ogg", "audio/wav": "wav",
               "audio/x-wav": "wav", "audio/mpeg": "mp3"}
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


@contextmanager
def session_db():
    conn = db()
    try:
        with conn:
            yield conn
    finally:
        conn.close()


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
    cols = [r[1] for r in conn.execute("PRAGMA table_info(children)")]
    if "password_hash" not in cols:
        conn.execute("ALTER TABLE children ADD COLUMN password_hash TEXT DEFAULT ''")
    conn.execute("""CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, role TEXT NOT NULL,
        child_id INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL)""")
    conn.execute("CREATE TABLE IF NOT EXISTS api_tokens (token_hash TEXT PRIMARY KEY, created TEXT NOT NULL)")


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


# Context-local presentation only; authorization always uses the request handler.
VIEW_SESSION = ContextVar("view_session", default=None)
SESSION_DAYS = 30


def password_hash(password):
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode(), salt, 200000)
    return salt.hex() + ':' + digest.hex()


def password_matches(password, stored):
    try:
        salt, expected = stored.split(':')
        digest = hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt), 200000)
        return hmac.compare_digest(digest.hex(), expected)
    except (ValueError, TypeError, AttributeError):
        return False


def cookie_value(handler, name):
    cookie = SimpleCookie()
    try:
        cookie.load(handler.headers.get('Cookie', ''))
        return cookie[name].value if name in cookie else ''
    except Exception:
        return ''


def get_session(handler):
    token = cookie_value(handler, 'sb_session')
    if not token:
        return None
    hashed = hashlib.sha256(token.encode()).hexdigest()
    with session_db() as conn:
        row = conn.execute('SELECT * FROM sessions WHERE token_hash=?', (hashed,)).fetchone()
        if not row:
            return None
        try:
            valid = datetime.fromisoformat(row['created']) > datetime.now() - timedelta(days=SESSION_DAYS)
        except (ValueError, TypeError):
            valid = False
        valid = valid and row['role'] in ('parent', 'student')
        if row['role'] == 'parent':
            valid = valid and row['child_id'] == 0
        elif row['role'] == 'student':
            valid = valid and bool(conn.execute("SELECT 1 FROM children WHERE id=? AND password_hash != ''", (row['child_id'],)).fetchone())
        if not valid:
            conn.execute('DELETE FROM sessions WHERE token_hash=?', (hashed,))
            return None
        return {'role': row['role'], 'child_id': row['child_id']}


def is_admin(handler):
    # Keep legacy cookies for already-signed-in browsers and compatibility.
    legacy = cookie_value(handler, 'admin')
    return bool(legacy and hmac.compare_digest(legacy.encode(), admin_token().encode())) or (get_session(handler) or {}).get('role') == 'parent'


def session_cookie(handler, token='', clear=False):
    # Only trust this header behind a trusted reverse proxy; do not expose the backend
    # to untrusted clients that can inject forwarded headers.
    secure = '; Secure' if handler.headers.get('X-Forwarded-Proto', '').lower() == 'https' else ''
    return f"sb_session={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={0 if clear else SESSION_DAYS * 86400}" + secure


def revoke_session(handler):
    with session_db() as conn:
        conn.execute('DELETE FROM sessions WHERE token_hash=?', (hashlib.sha256(cookie_value(handler, 'sb_session').encode()).hexdigest(),))


def start_session(handler, role, child_id=0):
    revoke_session(handler)
    token = secrets.token_urlsafe(32)
    with session_db() as conn:
        conn.execute('INSERT INTO sessions VALUES (?,?,?,?)',
                     (hashlib.sha256(token.encode()).hexdigest(), role, child_id, datetime.now().isoformat()))
    return session_cookie(handler, token)


def view_children():
    children = get_children()
    session = VIEW_SESSION.get()
    if session and session['role'] == 'student':
        return [c for c in children if c['id'] == session['child_id']]
    return children


def login_page(failed=False):
    message = "<p role='alert'>名字或密码不对</p>" if failed else ''
    return page('登录 - 作业板', "<div class='card'><h1>登录作业本</h1>" + message +
                "<form method='post' action='/login'><label for='login-name'>孩子名字</label>"
                "<input id='login-name' name='name' autocomplete='username' required>"
                "<label for='login-password'>密码</label><input id='login-password' type='password' name='password' autocomplete='current-password' required>"
                "<button class='full'>登录</button></form><p><a href='/admin'>家长登录</a></p></div>")


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
        return {}, None, "", ""
    boundary = b"--" + m.group(1).strip().strip('"').encode()
    body = handler.rfile.read(length)
    fields, file_bytes, filename, file_ctype = {}, None, "", ""
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
            cm = re.search(br"Content-Type:\s*([^\r;]+)", head, re.I)
            if cm:
                file_ctype = cm.group(1).decode("utf-8", "replace").strip().lower()
        else:
            fields[name] = content.decode("utf-8", "replace")
    return fields, file_bytes, filename, file_ctype


def original_filename(name):
    """只做路径清理，保留中文、空格和原扩展名，显示和下载都用这个。"""
    name = (name or "").replace("\\", "/").split("/")[-1].strip()
    return name[:120] if name else ""


def stored_name(original):
    ext = os.path.splitext(original)[1].lower()
    ext = re.sub(r"[^a-z0-9.]", "", ext)[:10]
    return secrets.token_hex(8) + ext


MIME_EXT = {"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif",
            "image/webp": ".webp", "image/heic": ".heic", "image/heif": ".heif",
            "image/bmp": ".bmp", "audio/mpeg": ".mp3", "audio/mp4": ".m4a",
            "audio/x-m4a": ".m4a", "audio/wav": ".wav", "audio/ogg": ".ogg",
            "audio/flac": ".flac", "video/mp4": ".mp4", "application/pdf": ".pdf"}


def sniff_mime(data):
    """按文件头猜类型：微信图片常没正经扩展名，文件名靠不住时用这个兜底。"""
    if not data:
        return ""
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG"):
        return "image/png"
    if data.startswith(b"GIF8"):
        return "image/gif"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    if len(data) >= 12 and data[4:8] == b"ftyp" and data[8:12] in (b"heic", b"heix", b"hevc", b"hevx"):
        return "image/heic"
    if data.startswith(b"%PDF"):
        return "application/pdf"
    if data.startswith(b"ID3") or data[:2] == b"\xff\xfb":
        return "audio/mpeg"
    return ""


def normalize_upload(original, file_bytes, part_ctype):
    """返回 (显示文件名, 存盘扩展名, mime)。
    微信分享的图片常叫 490.pic_hd、xxx.pic 这类“奇葩名”：扩展名是假的，
    真类型在 multipart 的 Content-Type 里，或者看文件头；这时按真类型改扩展名，
    否则页里认不出是图片，只能当下载链接。已有正经扩展名的原样不动。"""
    stem, ext = os.path.splitext(original)
    ext = ext.lower()
    guessed = mimetypes.guess_type(original)[0] or ""
    weird = bool(re.match(r"\.pic(_hd|_th|_mid|_sm)?$", ext)) or not ext or not guessed
    mime = ""
    if weird:
        raw = (part_ctype or "").split(";")[0].strip()
        # application/octet-stream 是“不知道”，不能挡住文件头嗅探
        mime = raw if raw in MIME_EXT else sniff_mime(file_bytes or b"")
        if mime in MIME_EXT:
            return stem + MIME_EXT[mime], MIME_EXT[mime], mime
        # 既没类型又嗅不出来：至少把 .pic 后缀去掉，别留着误导人
        if re.match(r"\.pic(_hd|_th|_mid|_sm)?$", ext):
            return stem, "", ""
        return original, ext, guessed
    return original, ext, guessed


def create_item(fields, file_bytes, filename, file_ctype=""):
    """标题不填就用文件名（去掉扩展名）；没文件也没标题就用正文开头或“未命名”。"""
    original = original_filename(filename)
    if file_bytes:
        original, _norm_ext, _norm_mime = normalize_upload(original, file_bytes, file_ctype or "")
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
        _disp, norm_ext, norm_mime = normalize_upload(original, file_bytes, file_ctype or "")
        original = _disp
        stored = secrets.token_hex(8) + norm_ext
        with open(os.path.join(UPLOAD_DIR, stored), "wb") as f:
            f.write(file_bytes)
        mime = norm_mime or mimetypes.guess_type(original)[0] or ""
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
.admin-hub{display:grid;gap:16px;margin-top:12px}
.admin-hub a{display:flex;align-items:center;gap:12px;background:#fff;border:1px solid #e8e8e8;border-radius:20px;padding:22px;box-shadow:0 1px 3px rgba(0,0,0,.05);color:#222}
.admin-hub a b{flex:1;font-size:20px}
.admin-hub a span:last-child{font-size:22px;color:#777}
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

.notebooks{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:12px}
.notebook{display:block;background:#fff;border:1px solid #e8e8e8;border-left:14px solid #2f66c4;
border-radius:20px;padding:22px;box-shadow:0 1px 3px rgba(0,0,0,.05);color:#222;
transition:transform 300ms ease,box-shadow 300ms ease}
.notebook h2{font-size:22px}.notebook .sub{color:#777;font-size:15px;margin-top:6px}
@media(min-width:701px){.binder{align-items:stretch}.binder-pane{max-height:calc(100dvh - 150px);overflow-y:auto}}
@media(max-width:700px){
 .binder{flex-direction:column}.binder-tabs{flex-direction:row;overflow-x:auto;width:auto;background:#f0f2f5}
 .binder-tab{border-bottom:0;border-right:1px solid #e8e8e8;min-width:116px;flex-shrink:0}
 .binder-tab.on{background:#fff}.spine{display:none}.binder-pane{padding:16px}
 .notebooks{grid-template-columns:1fr}
}
@media(prefers-reduced-motion:reduce){.notebook{animation:none!important;transition:none!important}}
@media(min-width:900px){.listgrid{grid-template-columns:1fr 1fr}}
/* Notebook overview and task-first pages. No webfonts or external assets. */
.notebook{display:flex;flex-direction:column;min-width:0;padding:0;overflow:hidden;transition:box-shadow 150ms ease}
.notebook-main{display:block;padding:22px;color:inherit;flex:1;min-height:230px}
.notebook-top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
.notebook-icon{display:block;width:24px;height:30px;border:2px solid currentColor;border-radius:3px;color:#657587;position:relative}.notebook-icon:before{content:"";position:absolute;left:5px;top:0;bottom:0;border-left:1px solid currentColor}.notebook-icon:after{content:"";position:absolute;left:10px;right:3px;top:8px;height:4px;border-top:1px solid currentColor;border-bottom:1px solid currentColor}.notebook-open{font-size:14px;color:#526477}
.notebook h2{font-size:22px;overflow-wrap:anywhere}.notebook-summary{font-size:18px;margin:14px 0 6px}
.notebook-summary strong{font-size:28px;font-variant-numeric:tabular-nums}
.notebook-meta{display:flex;flex-wrap:wrap;gap:6px 12px;font-size:14px;color:#59616c}
.notebook-next{font-size:14px;color:#59616c;border-top:1px solid #edf0f3;margin-top:16px;padding-top:12px;overflow-wrap:anywhere}
.notebook-footer{padding:8px 22px;border-top:1px solid #edf0f3;background:#fafbfc}
.notebook-footer a{display:inline-flex;align-items:center;min-height:44px;font-size:14px}
.book-context{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:8px 0}
.book-context h1{font-size:20px;margin:0;overflow-wrap:anywhere}.book-context a{font-size:14px;min-height:44px;display:inline-flex;align-items:center}
.task-overview{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}.task-overview h2{font-size:22px}
.task-overview .muted{margin:0}.due-label{color:#8a5a25;font-weight:600}.shared-note{font-size:13px;color:#59616c;margin:6px 0}
.subject-link{display:flex;align-items:center;gap:12px;padding:11px 0;border-top:1px solid #edf0f3;color:#222;min-height:56px}
.subject-link .t{flex:1}.subject-link small{display:block;color:#59616c}.subject-link .arrow{color:#647487}
.section-heading{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:18px}.section-heading a{font-size:14px;min-height:44px;display:flex;align-items:center}
.entry-switch{display:flex;gap:8px;padding:5px;background:#e9edf3;border-radius:16px;margin:12px 0}
.entry-switch[hidden],[hidden]{display:none!important}.entry-switch button{flex:1;background:transparent;color:#536174;min-height:48px}
.entry-switch button[aria-pressed=true]{background:#fff;color:#244f94;box-shadow:0 1px 3px #00000012}
.entry-header h1{font-size:24px}.entry-header p{margin:4px 0}.entry-section>h2{font-size:20px}
.form-field{display:block;margin:10px 0 4px;font-size:14px;color:#59616c}.advanced-fields>summary{cursor:pointer;min-height:48px;display:flex;align-items:center;color:#2f66c4;font-size:15px}
.form-note{margin:0 0 10px;color:#59616c;font-size:13px}.draft-error{color:#a43d38;font-size:14px;margin:8px 0}.draft-card.has-error{border-color:#b94a48}
.draft-card label{display:block;font-size:14px;color:#59616c}.draft-card label input,.draft-card label select,.draft-card label textarea{display:block}
.binder-tab[aria-current=page]{font-weight:700}.notebook-main:focus-visible{outline-offset:-5px}.muted{color:#626b76}.row .meta{color:#626b76}
@media(max-width:700px){.topnav{display:none}.notebooks{gap:14px;margin-top:4px}.notebook-main{min-height:0;padding:18px}.notebook-top{margin-bottom:10px}.notebook h2{font-size:21px}.notebook-summary{margin-top:10px}.notebook-next{margin-top:12px}.notebook-footer{padding:4px 18px}.book-context{margin:0 0 6px}.entry-section.card{margin-top:10px}.entry-switch{margin:10px 0}.binder-tabs{scrollbar-width:thin}.binder-tabs:after{content:'';width:18px;flex-shrink:0}.entry-switch button{padding:0 10px;font-size:16px}}

"""


def page(title, body):
    session = VIEW_SESSION.get()
    student = session and session["role"] == "student"
    links = [("/", "首页", "🏠"), ("/register", "登记", "✏️")] if session else []
    if session and not student:
        links.append(("/admin", "管理", "⚙️"))
    topnav = " ｜ ".join(f"<a href='{href}'>{label}</a>" for href, label, icon in links)
    bottomnav = ''.join(f"<a href='{href}'><span>{icon}</span>{label}</a>" for href, label, icon in links)
    logout = "<form method='post' action='/logout' class='session-bar'><button class='ghost small'>退出登录</button></form>" if student else ''
    content = ("<!DOCTYPE html><html lang='zh-CN'><head><meta charset='utf-8'>"
            "<meta name='viewport' content='width=device-width,initial-scale=1'>"
            f"<title>{esc(title)}</title><style>{CSS}</style>"
            "<link rel='stylesheet' href='/static/media.css'>"
            "<link rel='stylesheet' href='/static/paper.css'><script src='/static/paper.js' defer></script>"
            "<script src='/static/media.js' defer></script>"
            "<link rel='manifest' href='/manifest.json'>"
            "<link rel='icon' type='image/png' sizes='192x192' href='/icon-192.png'>"
            "<link rel='apple-touch-icon' href='/apple-touch-icon.png'>"
            "<meta name='theme-color' content='#2f66c4'>"
            "<meta name='apple-mobile-web-app-capable' content='yes'>"
            "<meta name='apple-mobile-web-app-title' content='登记簿'>"
            "<meta name='apple-mobile-web-app-status-bar-style' content='default'></head><body>"
            "<a class='skip' href='#main'>跳到内容</a>"
            f"<nav class='topnav' aria-label='顶部导航'>{topnav}</nav>"
            f"<main id='main'>{logout}{body}</main>"
            f"<nav class='bottomnav' aria-label='底部导航'>{bottomnav}</nav>"
            "<script>if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js').catch(function(){});}"
            "document.querySelectorAll('form').forEach(function(f){"
            "f.addEventListener('submit',function(e){"
            "if(f.dataset.submitting){e.preventDefault();return;}"
            "f.dataset.submitting='1';var b=f.querySelector('button');"
            "if(b){b.textContent='处理中…';}});});</script>"
            "</body></html>")
    return content.encode()


def contextual_page(title, body, child=0):
    content = page(title, body)
    if child and any(c["id"] == child for c in get_children()):
        content = content.replace(b"href='/register'", f"href='/register?child={child}'".encode())
    return content


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


def due_presets():
    """Use the same server calendar as homework progress and AI due defaults."""
    current = date.fromisoformat(today())
    return [("today", "今天", current.isoformat()),
            ("tomorrow", "明天", (current + timedelta(days=1)).isoformat()),
            ("sunday", "本周日", (current + timedelta(days=6-current.weekday())).isoformat()),
            ("clear", "清空", "")]


def due_field_shortcuts(target):
    return "<div class='due-presets' data-due-shortcuts hidden aria-label='快捷填写截止日期'>" + "".join(
        f"<button type='button' class='ghost small' data-due-target='{target}' data-due-value='{value}'>{label}</button>"
        for _, label, value in due_presets()) + "</div>"


def item_actions(it, child=0, detail=False):
    session = VIEW_SESSION.get()
    if not item_edit_allowed(it, session):
        return ""
    context = f"&child={child}" if child else ""
    out = (f"<div class='item-actions'><a class='item-edit' href='/item/edit?id={it['id']}{context}' "
           f"aria-label='修改：{esc(it['title'])}'>修改</a>")
    if it['kind'] == 'homework':
        back = f"/item?id={it['id']}{context}" if detail else '/' + qs(child)
        buttons = "".join(f"<button class='ghost small' name='preset' value='{key}'>{label}</button>"
                          for key, label, _ in due_presets())
        out += ("<details class='quick-due'><summary>改截止日期</summary>"
                "<form method='post' action='/item/due' class='quick-due-form'>"
                f"<input type='hidden' name='id' value='{it['id']}'>"
                f"<input type='hidden' name='return_to' value='{esc(back)}' data-notebook-return>"
                f"<p class='form-note'>当前：{esc(it['due'] or '未设截止日期')} · 日期按服务器时区</p>"
                f"<div class='due-presets'>{buttons}</div>"
                f"<label class='form-field' for='quick-due-{it['id']}'>自选截止日期</label>"
                f"<div class='due-custom'><input id='quick-due-{it['id']}' type='date' name='due' value='{esc(it['due'] or '')}'>"
                "<button name='preset' value='custom' class='small'>保存日期</button></div>"
                "<p class='form-note'>点快捷日期立即保存；只改日期，不改内容和完成状态。</p></form></details>")
    if detail and session['role'] == 'student':
        out += f"<a class='back' href='/item/delete?id={it['id']}'>删除</a>"
    return out + "</div>"


def notebook_return(value, fallback='/'):
    value = value or ''
    try:
        parsed = urlparse(value)
    except ValueError:
        return fallback
    if parsed.scheme or parsed.netloc or not value.startswith('/') or value.startswith('//'):
        return fallback
    if parsed.path not in ('/', '/item') or any(ord(c) < 32 or c == '\\' for c in value):
        return fallback
    return quote(value, safe="/?=&%#:+,;@!$'()*[]~-")


def valid_due_date(value):
    try:
        return not value or (bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", value)) and date.fromisoformat(value).isoformat() == value)
    except ValueError:
        return False


def compact_row(it, child=0, show_subject=False):
    kind = KINDS.get(it["kind"], it["kind"])
    meta = (esc(it["subject"]) + " · " if show_subject else "") + kind
    if it["kind"] == "homework" and not it["done"]:
        meta += " · <span class='due-label'>" + esc(due_label(it)) + "</span>"
    elif it["due"]:
        meta += " · 截止 " + esc(it["due"])
    if not it.get("child_id"):
        meta += " · 共享（完成同步所有本子）" if it["kind"] == "homework" else " · 共享"
    if it["kind"] == "homework" and it["done"]:
        meta += " · ✅ 已完成"
    done_btn = ""
    if it["kind"] == "homework" and not it["done"]:
        done_btn = (f"<form method='post' action='/done' style='margin:0'>"
                    f"<input type='hidden' name='id' value='{it['id']}'>"
                    f"<button class='done small' aria-label='标为已完成：{esc(it['title'])}{'（所有本子共享状态）' if not it.get('child_id') else ''}'>✓ 完成</button></form>")
    return (f"<div class='row'><div class='t'><a href='/item?id={it['id']}{('&child=' + str(child)) if child else ''}'>{esc(it['title'])}</a>"
            f"<div class='meta'>{meta}</div>{item_actions(it, child)}</div>{done_btn}</div>")


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
        if mime.startswith("image/") or mime == "application/pdf" or it["filename"].lower().endswith(".pdf"):
            gallery_child = it.get("child_id", 0) or child
            gallery = visible_items(all_items())
            gallery = filter_child(gallery, gallery_child) if gallery_child else [x for x in gallery if not x.get("child_id")]
            gallery = [x for x in gallery if x["subject"] == it["subject"] and x["stored"] and (x["mime"] or "").startswith("image/")]
            images = [{"url": "/uploads/" + quote(x["stored"]), "title": x["title"], "name": x["filename"]} for x in sorted(gallery, key=lambda x: x["id"])]
            if mime.startswith("image/"):
                if not any(x["url"] == url for x in images):
                    images.insert(0, {"url": url, "title": it["title"], "name": it["filename"]})
                out += (f"<a class='media-open image-open' href='{url}' data-type='image' data-gallery='{esc(json.dumps(images, ensure_ascii=False))}' data-url='{url}' data-title='{esc(it['title'])}'>"
                        f"<img src='{url}' alt='{esc(it['filename'])}'><span>全屏看图 · 同本同科图片可左右翻动</span></a>")
            else:
                out += (f"<div class='document-cover'><p>PDF · {esc(it['filename'])}</p>"
                        f"<a class='btn media-open' href='{url}' data-type='pdf' data-url='{url}' data-title='{esc(it['title'])}'>全屏阅读 PDF</a>"
                        "<p class='muted'>逐页翻动、跳页与缩放；无法显示时可打开原文件。</p></div>")
            out += f"<p><a href='{url}' target='_blank' rel='noopener'>打开原文件 ↗</a></p>"
        elif mime.startswith("audio/"):
            out += (f"<section class='listening-player' data-title='{esc(it['title'])}' aria-label='听力播放器'>"
                    "<div class='audio-heading'><div class='audio-art' aria-hidden='true'>"
                    "<svg viewBox='0 0 120 120' focusable='false'><circle cx='60' cy='60' r='43'/><circle cx='60' cy='60' r='28'/>"
                    "<path d='M30 60v3m10-15v27m10-38v48m10-55v60m10-48v36m10-25v15m10-8v3'/></svg></div>"
                    "<div class='audio-heading-text'><p class='widget-label'><span class='widget-dot' aria-hidden='true'></span>听力练习</p>"
                    f"<p class='audio-title'>{esc(it['title'])}</p><p class='audio-filename'>{esc(it['filename'])}</p>"
                    "<div class='audio-equalizer' aria-hidden='true'><i></i><i></i><i></i><i></i><i></i></div></div></div>"
                    f"<audio controls src='{url}' preload='metadata'></audio>"
                    "<div class='audio-enhanced' hidden><div class='audio-primary'>"
                    "<button class='audio-play' type='button' aria-label='播放'>播放</button>"
                    "<div class='audio-timeline'><div class='audio-times'><span class='audio-current'>00:00</span><span class='audio-duration'>--:--</span></div>"
                    "<input class='audio-seek' type='range' min='0' max='1000' value='0' aria-label='播放进度' disabled></div></div>"
                    "<div class='audio-tools'><button type='button' data-skip='-10'>后退 10 秒</button><button type='button' data-skip='10'>前进 10 秒</button>"
                    "<label>速度 <select class='audio-rate' aria-label='播放速度'><option value='0.75'>0.75×</option><option value='1' selected>1×</option><option value='1.25'>1.25×</option><option value='1.5'>1.5×</option><option value='2'>2×</option></select></label></div>"
                    "<details class='audio-practice'><summary>跟读练习 · 循环与 AB 复读</summary><div class='audio-tools'>"
                    "<button type='button' class='audio-loop' aria-pressed='false'>整段循环：关</button><button type='button' class='audio-a'>设起点 A</button>"
                    "<button type='button' class='audio-b'>设终点 B</button><button type='button' class='audio-clear'>清除 AB</button></div>"
                    "<p class='audio-ab muted'>先设起点，再播放到终点设置 B；不改变原文件。</p></details>"
                    "<button type='button' class='audio-native ghost small'>使用浏览器播放器</button></div>"
                    "<p class='audio-status muted' role='status' aria-live='polite'>加载音频信息…</p></section>")
        out += f"<p><a href='{url}?download=1'>⬇ 下载：{esc(it['filename'])}</a></p>"
    if it["kind"] == "homework":
        label = "↩ 取消完成" if it["done"] else "✅ 标为已完成"
        cls = "" if it["done"] else "done"
        if not it.get("child_id") and len(children) > 1:
            out += "<p class='shared-note'>这是一份历史共享作业，完成状态会同步到所有本子；新登记仅支持具体孩子，此记录未迁移或删除。</p>"
        out += (f"<form method='post' action='/done'><input type='hidden' name='id' value='{it['id']}'>"
                f"<button class='{cls}'>{label}</button></form>")
    if not detail:
        out += f"<p><a href='/item?id={it['id']}'>打开详情 →</a></p>"
    if detail:
        out += item_actions(it, child, detail=True)
    return out + "</div>"


def is_today(it):
    return it["pinned"] or it["due"] == today() or it["created"][:10] == today()


def timer_card(child=0):
    # SVG ornament is original; the clock, progress and controls are real DOM.
    ticks = "".join(f"<line x1='100' y1='9' x2='100' y2='{18 if n % 5 == 0 else 14}' "
                    f"transform='rotate({n * 6} 100 100)'/>" for n in range(60))
    return (f"<section class='paper-widget focus-widget' data-focus-timer data-child='{child}' aria-label='专注计时器'>"
            "<h3 class='widget-label'><span class='widget-dot' aria-hidden='true'></span>专注一下</h3>"
            "<div class='focus-dial'><svg viewBox='0 0 200 200' aria-hidden='true' focusable='false'>"
            f"<g class='focus-ticks'>{ticks}</g><circle class='focus-track' cx='100' cy='100' r='75'/>"
            "<circle class='focus-arc' cx='100' cy='100' r='75' pathLength='100' transform='rotate(-90 100 100)'/></svg>"
            "<div class='focus-center'><span class='timer focus-time'>25:00</span><span class='focus-caption'>留一段时间，做一件事</span></div></div>"
            "<div class='focus-presets' role='group' aria-label='专注时长'>"
            "<button type='button' data-minutes='15' aria-pressed='false'>15 分钟</button>"
            "<button type='button' data-minutes='25' aria-pressed='true'>25 分钟</button>"
            "<button type='button' data-minutes='45' aria-pressed='false'>45 分钟</button></div>"
            "<div class='focus-actions'><button class='focus-toggle' type='button' disabled>开始专注</button>"
            "<button class='focus-reset' type='button' aria-label='重置专注计时器' disabled>重置</button></div>"
            "<p class='focus-status muted' role='status' aria-live='polite'>准备好了就开始</p>"
            "<noscript><p class='muted'>计时器需要启用 JavaScript；作业进度仍可直接查看。</p></noscript></section>")


def homework_periods(items, day=None):
    """Disjoint due-date cohorts; undated legacy tasks use their registration day."""
    day = day or today()
    periods = {"today": [], "history": [], "future": []}
    for item in items:
        if item["kind"] != "homework":
            continue
        task_day = item["due"] or item["created"][:10]
        key = "today" if task_day == day else ("history" if task_day < day else "future")
        periods[key].append(item)
    return periods


def progress_widget(stats, per_subject, child):
    periods = homework_periods(stats['homework'])

    def cohort(key, label, scope, primary=False):
        tasks = periods[key]
        total = len(tasks)
        done = sum(1 for i in tasks if i['done'])
        percent = round(done * 100 / total) if total else 0
        bars = []
        for subject in per_subject:
            subject_tasks = [i for i in tasks if i['subject'] == subject]
            if not subject_tasks:
                continue
            completed = sum(1 for i in subject_tasks if i['done'])
            value = round(completed * 100 / len(subject_tasks))
            bars.append(f"<a class='subject-progress' href='/{qs(child, subject=subject)}'>"
                        f"<span class='subject-progress-name'>{esc(subject)}</span>"
                        f"<span class='paper-track' aria-hidden='true'><i style='width:{value}%'></i></span>"
                        f"<span class='subject-progress-value'><span class='sr-only'>已完成 </span>{completed} / {len(subject_tasks)}</span></a>")
        description = f"已完成 {done} / {total} 项作业"
        content = (f"<p class='progress-description'>{description}</p>"
                   f"<div class='paper-track progress-total' role='progressbar' aria-label='{label}完成率' aria-valuemin='0' aria-valuemax='100' "
                   f"aria-valuenow='{percent}' aria-valuetext='{description}'><i style='width:{percent}%'></i></div>"
                   f"<div class='subject-progress-list'>{''.join(bars)}</div>"
                   f"<p class='progress-scope'>{scope}</p>")
        if primary:
            message = '今天没有待统计的作业' if not total else ('今日作业都完成了' if done == total else '一点一点，把今天的待办变成完成')
            return (f"<div data-progress-period='{key}'><h3 class='widget-label' id='progress-title'><span class='widget-dot' aria-hidden='true'></span>{label}</h3>"
                    f"<div class='progress-number'>{percent}<span>%</span></div>" + content + f"<p class='widget-note'>{message}</p></div>")
        return (f"<details class='progress-period' data-progress-period='{key}'><summary>{label} · {done} / {total} 项已完成</summary>"
                + content + "</details>")

    return ("<section class='paper-widget progress-widget' aria-labelledby='progress-title'>"
            + cohort('today', '今日进度', '截止日期为今天；未设截止日期时按登记日统计。', True)
            + cohort('history', '历史进度', '截止日期早于今天；未设截止日期时按登记日统计。不含今日与未来作业。')
            + cohort('future', '未来作业', '截止日期晚于今天；未设截止日期时按登记日统计。不计入今日进度。')
            + "</section>")


def child_chips(children, child, view=""):
    if not children:
        return ""
    links = [f"<a class='{'on' if child == 0 else ''}' href='/{qs(0, view=view)}'>全部</a>"]
    for c in children:
        links.append(f"<a class='{'on' if child == c['id'] else ''}' href='/{qs(c['id'], view=view)}'>{esc(c['name'])}</a>")
    return "<div class='chips'>" + "".join(links) + "</div>"


def binder_tabs(subjects, per_subject, active, child, view):
    """活页夹标签：封面“总览” + 每门一页，标签上带该门的条数，点标签就是翻页。
    标签和纸面共用一个外框，活动标签背景就是纸面白，中间没有双边框、没有错位圆角。"""
    tabs = [f"<a aria-current='{'page' if active == '' else 'false'}' class='binder-tab{' on' if not active else ''}' "
            f"href='/{qs(child, view=view)}'><span>📕</span><span class='n'>总览</span></a>"]
    for s in subjects:
        icon, bg, color = subject_meta(s)
        n = len(per_subject.get(s, []))
        if n == 0 and active != s:
            continue
        tabs.append(f"<a aria-current='{'page' if active == s else 'false'}' "
                    f"class='binder-tab{' on' if active == s else ''}' style='border-left:6px solid {color}' "
                    f"href='/{qs(child, subject=s, view=view)}'><span>{icon}</span><span class='n'>{esc(s)}</span>"
                    f"<span class='cnt'>{n}</span></a>")
    return "<nav class='binder-tabs' aria-label='学科活页夹'>" + "".join(tabs) + "</nav>"


def binder_wrap(tabs, pane):
    spine = "<div class='spine' aria-hidden='true'><i></i><i></i><i></i><i></i><i></i></div>"
    return (f"<div class='binder'>{tabs}{spine}<div class='binder-pane'>{pane}</div></div>"
            "<script>var t=document.querySelector('.binder-tab.on');if(t&&matchMedia('(max-width:700px)').matches){t.parentElement.scrollLeft=Math.max(0,t.offsetLeft-t.parentElement.offsetLeft-12);}</script>")


def homework_summary(items):
    """Visible tasks, including shared items, counted once per notebook."""
    homework = [i for i in items if i["kind"] == "homework"]
    pending = sorted((i for i in homework if not i["done"]),
                     key=lambda i: (i["due"] or "9999-12-31", -i["pinned"], i["id"]))
    return {"homework": homework, "pending": pending,
            "overdue": sum(1 for i in pending if i["due"] and i["due"] < today()),
            "today": sum(1 for i in pending if i["due"] == today()),
            "undated": sum(1 for i in pending if not i["due"]),
            "done": sum(1 for i in homework if i["done"])}


def due_label(it):
    if not it["due"]:
        return "未设截止日期"
    if it["due"] < today():
        return "已逾期 · " + it["due"]
    if it["due"] == today():
        return "今天截止"
    return "截止 " + it["due"]


def notebook_context(children, child):
    name = child_name(children, child) or (children[0]["name"] if len(children) == 1 else "")
    title = esc(name) + "的作业登记簿" if name else "作业登记簿"
    switch = "<a href='/'>← 选其他本子</a>" if len(children) > 1 else ""
    return f"<header class='book-context'><h1>{title}</h1>{switch}</header>"


def notebook_covers(children, items):
    """Independent notebook summaries; shared items match the opened notebook."""
    colors = ["#2f66c4", "#2e7d5b", "#c2702e", "#6a4fc4", "#b94a48"]
    cards = []
    for c in children:
        mine = filter_child(items, c["id"])
        stats = homework_summary(mine)
        shared = sum(1 for i in mine if not i.get("child_id"))
        pending = stats["pending"]
        summary = (f"<strong>{len(pending)}</strong> 项待完成" if pending else "暂无待完成作业")
        urgent = []
        if stats["overdue"]:
            urgent.append(f"<span class='due-label'>已逾期 {stats['overdue']} 项</span>")
        if stats["today"]:
            urgent.append(f"<span>今天截止 {stats['today']} 项</span>")
        if stats["undated"]:
            urgent.append(f"<span>未设日期 {stats['undated']} 项</span>")
        if not urgent:
            urgent.append("<span>按自己的节奏来</span>" if pending else "<span>可翻看通知和学习资料</span>")
        next_item = (f"接下来 · {esc(pending[0]['subject'])} · {esc(pending[0]['title'])}"
                     if pending else f"共 {len(mine)} 条内容，打开本子查看")
        color = colors[(c["id"] - 1) % len(colors)]
        periods = homework_periods(mine)
        total = len(periods["today"])
        today_done = sum(1 for i in periods["today"] if i["done"])
        history_pending = sum(1 for i in periods["history"] if not i["done"])
        percent = round(today_done * 100 / total) if total else 0
        cards.append(f"<article class='notebook' style='border-left-color:{color}'>"
                     f"<a class='notebook-main' href='/?child={c['id']}' aria-label='打开{esc(c['name'])}的作业登记簿'>"
                     "<div class='notebook-top'><span class='notebook-icon' aria-hidden='true'></span><span class='notebook-open'>打开本子 →</span></div>"
                     f"<h2>{esc(c['name'])}的作业登记簿</h2><div class='notebook-summary'>{summary}</div>"
                     f"<div class='notebook-meta'>{''.join(urgent)}</div>"
                     f"<div class='notebook-progress'><span>今日已完成 {today_done} / {total} 项作业</span>"
                     f"<span class='paper-track' aria-hidden='true'><i style='width:{percent}%'></i></span></div>"
                     f"<p class='form-note'>历史待完成 {history_pending} 项 · 未来作业 {len(periods['future'])} 项</p>"
                     f"<div class='notebook-next'>{next_item}</div>"
                     f"<div class='sub'>{len(mine)} 条内容 · 含 {shared} 条共享内容</div></a>"
                     f"<footer class='notebook-footer'><a href='/register?child={c['id']}'>＋ 给{esc(c['name'])}登记</a></footer></article>")
    return "<section class='notebooks' aria-label='选择孩子的登记簿'>" + "".join(cards) + "</section>"




def add_form(subjects, children, action="/add", preselect_subject="", preselect_child=0, show_extra=True):
    subj_chips = "".join(
        f"<label class='chip'><input type='radio' name='subject' value='{esc(s)}' "
        f"{'checked' if s == (preselect_subject or '语文') else ''}> {esc(s)}</label>" for s in subjects)
    kind_chips = "".join(
        f"<label class='chip'><input type='radio' name='kind' value='{k}' "
        f"{'checked' if k == 'notice' else ''}> {v}</label>" for k, v in KINDS.items())
    child_radios = ""
    if children:
        child_radios = ("<fieldset style='border:0;padding:0;margin:0'><legend class='form-field'>给谁</legend><div class='chips'>" +
                        "".join(f"<label class='chip'><input type='radio' name='child_id' required value='{c['id']}' "
                                f"{'checked' if preselect_child == c['id'] else ''}> {esc(c['name'])}</label>"
                                for c in children) + "</div></fieldset>")
    if (VIEW_SESSION.get() or {}).get('role') == 'student':
        child_radios = f"<input type='hidden' name='child_id' value='{preselect_child}'>"
    extra = ""
    if show_extra:
        extra = ("<label class='form-field' for='entry-visible'>到这个时间才显示（答案类建议填）</label>"
                 "<input id='entry-visible' type='datetime-local' name='visible_at'>"
                 "<label style='display:flex;gap:10px;align-items:center;min-height:48px'>"
                 "<input type='checkbox' name='pinned'> 置顶提醒</label>")
    return (f"<form method='post' action='{action}' enctype='multipart/form-data'>"
            f"{child_radios}<div class='manual-fields'><div class='entry-wide'>"
            "<label class='form-field' for='entry-title'>标题</label>"
            "<input id='entry-title' name='title' placeholder='例如：数学练习册第 10 页' aria-describedby='title-hint'>"
            "<p id='title-hint' class='form-note'>可留空，自动使用文件名或正文首行。</p></div><div>"
            f"<fieldset style='border:0;padding:0;margin:0'><legend class='form-field'>学科</legend><div class='chips'>{subj_chips}</div></fieldset></div><div>"
            f"<fieldset style='border:0;padding:0;margin:0'><legend class='form-field'>类型</legend><div class='chips'>{kind_chips}</div></fieldset></div><div class='entry-wide'>"
            "<label class='form-field' for='entry-body'>文字内容</label>"
            "<textarea id='entry-body' name='body' rows='4' placeholder='通知正文、作业要求…'></textarea></div><div>"
            "<label class='form-field' for='entry-due'>截止日期（可选）</label><input id='entry-due' type='date' name='due'></div><div>"
            "<label class='form-field' for='entry-file'>附件（可选）</label>"
            "<input id='entry-file' type='file' name='file' aria-describedby='file-hint'>"
            "<p id='file-hint' class='form-note'>PDF / 图片 / MP3，最大 50MB，保留中文文件名。</p></div></div>"
            "<details class='advanced-fields'><summary>更多选项：原链接、定时显示、置顶</summary>"
            "<label class='form-field' for='entry-link'>原链接</label><input id='entry-link' name='link_url' type='url' placeholder='https://…'>"
            f"{extra}</details><button class='full entry-submit'>登记到当前孩子的本子</button></form>")


def kid_page(params):
    session = VIEW_SESSION.get()
    if session and session['role'] == 'student':
        params = dict(params, child=[str(session['child_id'])])
    try:
        child = int(params.get("child", ["0"])[0])
    except ValueError:
        child = 0
    subject = params.get("subject", [""])[0]
    view = "all"
    q = params.get("q", [""])[0].strip()
    children = view_children()
    if child and not any(c["id"] == child for c in children):
        child = 0
    if len(children) == 1 and not child:
        child = children[0]["id"]
    items = filter_child(visible_items(all_items()), child)
    hidden = len(filter_child(all_items(), child)) - len(items)
    subjects = get_subjects()
    stats = homework_summary(items)
    context = notebook_context(children, child)
    per_subject = {}
    for s in subjects:
        per_subject[s] = [i for i in items if i["subject"] == s]
    tabs = binder_tabs(subjects, per_subject, subject, child, view)
    if params.get("pending", [""])[0] == "1":
        pane = ("<h2>全部待办</h2><p class='muted'>按截止日期排序，未设日期排在最后。</p>"
                + "".join(compact_row(i, child, show_subject=True) for i in stats["pending"])
                + ("<p class='muted'>没有待完成作业。</p>" if not stats["pending"] else ""))
        return contextual_page("待办 - 作业板", context + binder_wrap(tabs, pane), child)
    if subject:
        shown = [i for i in items if i["subject"] == subject]
        shown.sort(key=lambda i: (0 if i["kind"] == "homework" and not i["done"] else 1,
                                  i["due"] or "9999-12-31"))
        if q:
            shown = [i for i in shown if q in i["title"] or q in i["body"]]
        icon, bg, color = subject_meta(subject)
        pane = (f"<div class='head' style='display:flex;gap:12px;align-items:center'>"
                f"<div class='icon' style='width:52px;height:52px;border-radius:16px;display:flex;align-items:center;justify-content:center;font-size:26px;background:{bg}'>{icon}</div>"
                f"<div><h2>{esc(subject)}</h2><div class='sub'>{len(shown)} 条 · "
                f"作业完成 {sum(1 for i in shown if i['kind'] == 'homework' and i['done'])}"
                f" / {sum(1 for i in shown if i['kind'] == 'homework')}</div></div></div>"
                + "".join(compact_row(i, child) for i in shown) +
                (empty_state("这门没有匹配的内容。",
                             f"<p><a class='back' href='/register{qs(child, subject=subject)}'>去登记{esc(subject)}</a></p>") if not shown else "") +
                f"<form method='get'><input name='q' aria-label='在这门里搜索' placeholder='在这门里搜' value='{esc(q)}'>"
                f"<input type='hidden' name='subject' value='{esc(subject)}'>"
                f"<input type='hidden' name='view' value='{esc(view)}'>"
                f"<input type='hidden' name='child' value='{child}'><button>搜索</button></form>")
        body = context + binder_wrap(tabs, pane)
        return contextual_page(f"{subject} - 作业板", body, child)
    pins = [i for i in items if i["kind"] == "announcement" and i["pinned"]][:2]
    # 封面页：少量待办、提醒、各科计数，不把所有作业堆在首页。
    if q:
        shown = [i for i in items if q in i["title"] or q in i["body"]]
        pane = (f"<h2>搜索“{esc(q)}”</h2>" + "".join(compact_row(i, child) for i in shown) +
                (empty_state(f"没搜到“{q}”，换个词试试，或者去登记一条。",
                             "<p><a class='back' href='/'>← 回首页</a></p>") if not shown else ""))
        body = context + binder_wrap(tabs, pane)
        return contextual_page("作业板", body, child)
    # 多孩且还没选本子：先看本子封面，不直接进活页夹；没有“不分本子看全部”这个需求
    if len(children) > 1 and not child and not subject:
        return page("选本子 - 作业板", notebook_covers(children, visible_items(all_items())))
    pane = ("<div class='paper-dashboard'>" + progress_widget(stats, per_subject, child) + timer_card(child) + "</div>"
            + f"<div class='task-overview'><h2>累计待完成 {len(stats['pending'])} 项</h2>"
            f"<p class='muted'>已完成 {stats['done']} / {len(stats['homework'])} 项作业</p></div>"
            f"<p class='muted'>已逾期 {stats['overdue']} · 今天截止 {stats['today']} · 未设日期 {stats['undated']}</p>")
    if hidden:
        pane += f"<p class='muted'>另有 {hidden} 条内容未到显示时间</p>"
    pending = stats["pending"]
    pane += ("<div class='section-heading'><h3>接下来要做</h3>"
             f"<a href='/{qs(child, pending='1')}'>全部待办 →</a></div>")
    if pending:
        pane += "".join(compact_row(i, child, show_subject=True) for i in pending[:3])
    else:
        pane += "<p class='muted'>没有待完成作业，通知和学习资料仍可在各科翻看。</p>"
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
        pane += (f"<a class='subject-link' href='/{qs(child, subject=s, view=view)}'>"
                 f"<span aria-hidden='true'>{icon}</span><span class='t'>{esc(s)}<small>{sub_line}</small></span>"
                 "<span class='arrow' aria-hidden='true'>→</span></a>")
    pane += (f"<form method='get'><input name='q' aria-label='搜索全部标题和内容' placeholder='搜全部标题 / 内容' value='{esc(q)}'>"
             f"<input type='hidden' name='view' value='{esc(view)}'>"
             f"<input type='hidden' name='child' value='{child}'><button>搜索</button></form>")
    body = context + binder_wrap(tabs, pane)
    return contextual_page("作业板", body, child)


def register_page(msg="", preselect_subject="", preselect_child=None):
    subjects, children = get_subjects(), view_children()
    api_help = """<details class='card'><summary style='cursor:pointer;min-height:48px;display:flex;align-items:center'>curl / iPhone 捷径上传（点开看）</summary>
<p class='muted'>下面把 HOST 换成这台服务器的地址，例如 HOST:8765（换成你这台服务器的地址）。</p>
<pre style='white-space:pre-wrap;word-break:break-all;font-size:14px'># 取孩子、学科和类型列表（给捷径做下拉）：GET http://HOST/api/lists
# 返回 {"children": [{"id": 1, "name": "孩子名字"}, ...], "subjects": ["语文", ...],
#       "kinds": [{"code": "homework", "label": "作业"}, ...]}
# 传一个文件，标题不填就用文件名；kind 不填时音频自动是听力、PDF 自动是学习资料
curl -F "file=@/path/数学练习.pdf" -F "subject=数学" -F "child_id=1" http://HOST/api/items

# 只传文字 / 链接
curl -d "title=本周通知&subject=语文&body=周五听写&child_id=1" http://HOST/api/items</pre>
<p>iPhone 捷径做法：分享菜单 → 新建捷径 → 接收“文件/图像/PDF”→
先“获取 URL 内容” GET http://HOST/api/lists，取字典里的 subjects、children 和 kinds
各做一个“从列表中选取”（孩子选 id、学科选名字、类型选 label 后取对应的 code），再“获取 URL 内容”选 POST、
表单，地址填 http://HOST/api/items，表单里 file=捷径输入、subject=上一步选的学科、
child_id=上一步选的孩子 id；kind 不用填，MP3 这类音频自动是听力、PDF 自动是学习资料，
想指定类型时再填 kind（从 lists 的 kinds 里取 code，别填中文 label）；
再把这个捷径加到分享菜单，以后在微信里长按文件 → 分享 → 这个捷径，
一步就登记进来了，不用先存文件再打开网页。手机须和服务器在同一局域网，
或都连着 Tailscale。</p>
<p class='muted'>这个接口只在局域网 / Tailscale 内可信，没有对外公开；
如需加口令，部署时设 API_TOKEN，请求再带 X-API-Token 头。</p></details>"""
    if not children:
        return page("登记 - 作业板", "<h1>先添加孩子</h1><p>每条新内容都需要归属到具体孩子。</p><a class='back' href='/admin/children'>去管理添加孩子</a>")
    if preselect_child is None or preselect_child == 0:
        if len(children) == 1:
            preselect_child = children[0]["id"]
        else:
            links = "".join(f"<a class='back' href='/register?child={c['id']}&subject={quote(preselect_subject)}'>给{esc(c['name'])}登记</a> " for c in children)
            return page("选择登记对象 - 作业板", "<h1>给哪个孩子登记？</h1><p>从孩子的本子进入会自动沿用，无需重复选择。</p>" + links)
    if not any(c["id"] == preselect_child for c in children):
        return error_page("登记对象已失效", "这个孩子可能已被删除，或链接不正确。请回首页重新选择本子，再登记。")
    context_options = "".join(f"<option value='{c['id']}' {'selected' if c['id'] == preselect_child else ''}>{esc(c['name'])}</option>" for c in children)
    context_html = ("<div class='card' id='registration-context' hidden><div class='context-copy'><label for='entry-child'>本次登记给</label>"
                    f"<select id='entry-child' aria-label='本次登记的孩子'>{context_options}</select></div>"
                    "<p class='form-note'>各录入方式自动沿用，不用重复姓名。切换只影响新内容；已有草稿可逐条改归属。</p></div>")
    session = VIEW_SESSION.get()
    if session and session['role'] == 'student':
        # 学生登记固定为自己，顶部的“本次登记给”提示不再需要；但 entry-child
        # 隐藏域必须保留，文字录入的 JS 靠它取孩子 id，JS 也会找
        # registration-context 这个容器。去掉卡片样式后空容器不占视觉空间。
        context_html = (f"<div id='registration-context' hidden>"
                        f"<input id='entry-child' type='hidden' value='{preselect_child}'></div>")
    if session and session['role'] == 'student':
        api_help = ''
    message_html = f"<p role='status'>{esc(msg)}</p>" if msg else ""
    body = ("<link rel='stylesheet' href='/static/entry.css'><div id='registration'><header class='entry-header'><h1>把今天的作业记下来</h1>"
            "<p class='muted'>写一句、拍张照，或手动记一条，核对后再创建。</p></header>"
            + message_html + context_html +
            "<div class='entry-switch' hidden aria-label='登记方式'>"
            "<button type='button' data-entry='ai' aria-controls='ai-entry' aria-pressed='true'>文字 / 拍照</button>"
            "<button type='button' data-entry='manual' aria-controls='manual-entry' aria-pressed='false'>手动登记</button></div>"
            "<section id='ai-entry' class='entry-section'>" + ai_entry_html(subjects, children) + "</section>"
            + "<section id='manual-entry' class='entry-section card'><p class='entry-step'>填写内容</p><h2>手动登记</h2>"
            + add_form(subjects, children, "/add", preselect_subject, preselect_child) + "</section>"
            + api_help
            + ("<p><a class='back' href='/'>← 回首页</a></p>" if (VIEW_SESSION.get() or {}).get('role') == 'student' else
               "<p><a class='back' href='/'>← 回首页</a> <a class='back' href='/admin'>去管理</a></p>") +
            "<script>(function(){var buttons=document.querySelectorAll('[data-entry]');"
            "function show(mode){document.getElementById('manual-entry').hidden=mode!=='manual';document.getElementById('ai-entry').hidden=mode!=='ai';"
            "buttons.forEach(function(b){b.setAttribute('aria-pressed',String(b.dataset.entry===mode));});}"
            "document.querySelector('.entry-switch').hidden=false;buttons.forEach(function(b){b.addEventListener('click',function(){show(b.dataset.entry);});});show('ai');})();</script>")
    body += """<script>(function(){
var context=document.getElementById('entry-child');
var radios=document.querySelectorAll('#manual-entry input[type="radio"][name="child_id"]');
if(radios.length) radios[0].closest('fieldset').hidden=true;
document.getElementById('registration-context').hidden=false;
context.addEventListener('change',function(){
  radios.forEach(function(r){r.checked=r.value===context.value;});
  var url=new URL(location.href);url.searchParams.set('child',context.value);history.replaceState(null,'',url);
  document.querySelectorAll('a[href^="/register"]').forEach(function(a){a.href='/register?child='+context.value;});
});
if(window.visualViewport){
  var fullHeight=window.innerHeight;
  function keyboard(){
    var editing=/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    document.body.classList.toggle('entry-keyboard',editing && window.visualViewport.height < fullHeight-120);
  }
  visualViewport.addEventListener('resize',keyboard);
  document.addEventListener('focusin',keyboard);document.addEventListener('focusout',keyboard);
}
})();</script>"""
    body += "</div>"
    return contextual_page("登记 - 作业板", body, preselect_child)


def admin_top(back_href, back_text):
    """子页面顶栏：只放回退 + 退出管理，不放任何删除按钮，避免误触。"""
    return (f"<div class='admin-bar'><a href='{back_href}'>{back_text}</a>"
            "<span style='flex:1'></span>"
            "<form method='post' action='/admin/logout' style='margin:0'>"
            "<button class='ghost small'>退出管理</button></form></div>")


def admin_page(msg=""):
    """管理首页：只做三个大入口，不直接放删除按钮；
    孩子/科目/登记内容各进自己的子页面，登记内容再按孩子分桶。"""
    items, subjects, children = all_items(), get_subjects(), get_children()
    hw = [i for i in items if i["kind"] == "homework"]
    done_n = sum(1 for i in hw if i["done"])
    body = (f"<div class='admin-bar'><span>作业完成 {done_n} / {len(hw)}</span>"
            f"<span class='muted'>共 {len(items)} 条 · {len(children)} 个孩子 · {len(subjects)} 门学科</span>"
            "<span style='flex:1'></span>"
            "<form method='post' action='/admin/logout' style='margin:0'><button class='ghost small'>退出管理</button></form></div>"
            f"{f'<p><b>{esc(msg)}</b></p>' if msg else ''}"
            "<div class='admin-hub'>"
            f"<a href='/admin/children'><b>孩子管理</b><span class='muted'>{len(children)} 个孩子</span><span>›</span></a>"
            f"<a href='/admin/subjects'><b>科目管理</b><span class='muted'>{len(subjects)} 门学科</span><span>›</span></a>"
            f"<a href='/admin/items'><b>登记项目管理</b><span class='muted'>{len(items)} 条 · 按孩子分开管理</span><span>›</span></a>"
            "</div>"
            "<p class='muted'><a href='/admin/api-token'>API 令牌（给 AI 用）→</a> 生成后 AI 才能调 /api，令牌只存哈希，生成那一刻外不显示明文。</p>")
    return page("管理 - 作业板", body)


def admin_children_page(msg=""):
    items, children = all_items(), get_children()
    child_rows = ""
    with session_db() as conn:
        password_states = {r['id']: bool(r['password_hash']) for r in conn.execute('SELECT id,password_hash FROM children')}
    for c in children:
        n = sum(1 for i in items if i.get("child_id") == c["id"])
        child_rows += (f"<div class='arow'>"
                       f"<form class='inline-form' style='flex:1;margin:0' method='post' action='/admin/child/rename'>"
                       f"<input type='hidden' name='id' value='{c['id']}'>"
                       f"<input name='name' value='{esc(c['name'])}' aria-label='孩子名字，改了点改名' required>"
                       f"<span class='meta' style='white-space:nowrap'>{n} 条</span>"
                       "<button type='submit' class='small'>改名</button></form>"
                       f"<form method='post' action='/admin/child/delete' style='margin:0'>"
                       f"<input type='hidden' name='id' value='{c['id']}'>"
                       "<button class='danger small'>删除</button></form></div>")
        child_rows += (f"<div class='card'><p>{esc(c['name'])} · {'已设密码' if password_states[c['id']] else '未设密码'}</p>"
                       "<form class='inline-form' method='post' action='/admin/child/password'>"
                       f"<input type='hidden' name='id' value='{c['id']}'>"
                       "<input type='password' name='password' aria-label='新密码，至少6位' placeholder='新密码，至少6位' autocomplete='new-password'>"
                       "<button name='operation' value='set'>设置 / 更新</button>"
                       "<button class='ghost' name='operation' value='clear'>清除密码</button></form></div>")
    body = (admin_top("/admin", "← 回管理")
            + (f"<p role='status'>{esc(msg)}</p>" if msg else '')
            + "<h3>孩子管理</h3>"
            + "<form class='inline-form' method='post' action='/admin/child'>"
            + "<input name='name' aria-label='孩子名字' placeholder='孩子名字，如：小明' required>"
            + "<button>加孩子</button></form>"
            + (child_rows or "<p class='muted'>还没加孩子。</p>"))
    return page("孩子管理 - 作业板", body)


def admin_subjects_page():
    items, subjects = all_items(), get_subjects()
    subj_rows = ""
    for s in subjects:
        n = sum(1 for i in items if i["subject"] == s)
        del_btn = (f"<form method='post' action='/admin/subject/delete' style='margin:0'>"
                   f"<input type='hidden' name='name' value='{esc(s)}'>"
                   "<button class='danger small'>删除</button></form>") if n == 0 else ""
        subj_rows += f"<div class='arow'><div class='t'><b>{esc(s)}</b><div class='meta'>{n} 条</div></div>{del_btn}</div>"
    body = (admin_top("/admin", "← 回管理")
            + "<h3>科目管理</h3>"
            + "<form class='inline-form' method='post' action='/admin/subject'>"
            + "<input name='name' aria-label='新学科' placeholder='新学科，如：道法' required>"
            + "<button>加学科</button></form>" + subj_rows)
    return page("科目管理 - 作业板", body)


def admin_items_page(child_id=None):
    items, children = all_items(), get_children()
    if child_id is None:
        buckets = [(0, "共享（未指定孩子）")] + [(c["id"], c["name"]) for c in children]
        links = ""
        for bid, label in buckets:
            n = sum(1 for i in items if i.get("child_id", 0) == bid)
            links += (f"<a href='/admin/items?child={bid}'><b>{esc(label)}</b>"
                      f"<span class='muted'>{n} 条</span><span>›</span></a>")
        body = (admin_top("/admin", "← 回管理")
                + "<h3>登记项目管理</h3>"
                + "<p class='muted'>先选孩子，再管理这个孩子的登记内容；删孩子不会删内容，删掉的孩子的内容会回到共享。</p>"
                + f"<div class='admin-hub'>{links}</div>")
        return page("登记项目管理 - 作业板", body)
    valid = [0] + [c["id"] for c in children]
    if child_id not in valid:
        return admin_items_page(None)
    label = "共享（未指定孩子）" if child_id == 0 else child_name(children, child_id)
    rows = ""
    for it in [i for i in items if i.get("child_id", 0) == child_id]:
        gated = it["visible_at"] and it["visible_at"] > now_dt()
        meta = f"{esc(it['subject'])} · {KINDS.get(it['kind'], '')}"
        if gated:
            meta += " · ⏳ 未到显示时间"
        if it['kind'] == 'homework' and it['done']:
            meta += " · ✅ 已完成"
        rows += (f"<div class='arow'><div class='t'><a href='/item?id={it['id']}'>{esc(it['title'])}</a>"
                 f"<div class='meta'>{meta}</div></div>"
                 f"<a class='small' href='/admin/item/edit?id={it['id']}'>修改</a>"
                 f"<form method='post' action='/admin/delete' style='margin:0'>"
                 f"<input type='hidden' name='id' value='{it['id']}'>"
                 "<button class='danger small'>删除</button></form></div>")
    body = (admin_top("/admin/items", "← 回登记项目管理")
            + f"<h3>{esc(label)}</h3>"
            + (rows or "<p>这个孩子还没有内容。</p>"))
    return page("登记项目管理 - 作业板", body)



def admin_item_edit_page(it, msg=""):
    """登记项目修改页（家长专用）：只改元数据，不动附件、创建时间与完成状态。"""
    subjects, children = get_subjects(), get_children()
    subj_options = "".join(
        f"<option value='{esc(s)}' {'selected' if s == it['subject'] else ''}>{esc(s)}</option>"
        for s in subjects)
    kind_options = "".join(
        f"<option value='{k}' {'selected' if k == it['kind'] else ''}>{v}</option>"
        for k, v in KINDS.items())
    child_options = "".join(
        f"<option value='{c['id']}' {'selected' if c['id'] == it['child_id'] else ''}>{esc(c['name'])}</option>"
        for c in children)
    if it['child_id'] == 0:
        child_options += "<option value='0' selected>共享（历史）</option>"
    attachment = ""
    if it.get('filename'):
        attachment = f"<p class='muted'>附件：{esc(it['filename'])}（本次修改不换附件）</p>"
    if it.get('done'):
        attachment += "<p class='muted'>完成状态：已完成（本次修改不改动）</p>"
    body = (admin_top(f"/admin/items?child={it['child_id']}", "← 回登记项目管理")
            + "<h3>修改登记项目</h3>"
            + (f"<p role='status'>{esc(msg)}</p>" if msg else '')
            + f"<form method='post' action='/admin/item/edit' class='card'>"
            f"<input type='hidden' name='id' value='{it['id']}'>"
            "<label class='form-field' for='edit-title'>标题</label>"
            f"<input id='edit-title' name='title' value='{esc(it['title'])}' required>"
            "<label class='form-field' for='edit-subject'>学科</label>"
            f"<select id='edit-subject' name='subject'>{subj_options}</select>"
            "<label class='form-field' for='edit-kind'>类型</label>"
            f"<select id='edit-kind' name='kind'>{kind_options}</select>"
            "<label class='form-field' for='edit-child'>归属孩子</label>"
            f"<select id='edit-child' name='child_id'>{child_options}</select>"
            "<label class='form-field' for='edit-body'>文字内容</label>"
            f"<textarea id='edit-body' name='body' rows='4'>{esc(it['body'] or '')}</textarea>"
            "<label class='form-field' for='edit-link'>原链接</label>"
            f"<input id='edit-link' name='link_url' type='url' value='{esc(it['link_url'] or '')}' placeholder='https://…'>"
            "<label class='form-field' for='edit-due'>截止日期（可选）</label>"
            f"<input id='edit-due' name='due' type='date' value='{esc(it['due'] or '')}'>"
            + due_field_shortcuts("edit-due") +
            "<label class='form-field' for='edit-visible'>到这个时间才显示（可选）</label>"
            f"<input id='edit-visible' name='visible_at' type='datetime-local' value='{esc(it['visible_at'] or '')}'>"
            "<label style='display:flex;gap:10px;align-items:center;min-height:48px'>"
            f"<input type='checkbox' name='pinned' {'checked' if it['pinned'] else ''}> 置顶提醒</label>"
            + attachment
            + "<button class='full'>保存修改</button></form>"
            f"<p><a class='back' href='/admin/items?child={it['child_id']}'>← 不改了，回去</a></p>")
    return page("修改登记项目 - 作业板", body)


def item_edit_allowed(it, session):
    """学生改删的权限：家长什么都能改；学生只能改自己可见的本子项目。

    历史共享（child_id=0）学生不能改删，改了会影响所有本子；未到显示时间的
    项目学生也看不到，同样不能从这里改删。"""
    if not it or not session:
        return False
    if session["role"] == "parent":
        return True
    if session["role"] != "student":
        return False
    if it.get("child_id") != session["child_id"]:
        return False
    return not (it.get("visible_at") and it["visible_at"] > now_dt())


def student_item_edit_page(it, msg="", return_to=""):
    """本子内编辑：学生仅限自己可见项目，家长也可直接改；保持归属不变。"""
    back = notebook_return(return_to, f"/item?id={it['id']}")
    subjects = get_subjects()
    subj_options = "".join(
        f"<option value='{esc(s)}' {'selected' if s == it['subject'] else ''}>{esc(s)}</option>"
        for s in subjects)
    kind_options = "".join(
        f"<option value='{k}' {'selected' if k == it['kind'] else ''}>{v}</option>"
        for k, v in KINDS.items())
    attachment = ""
    if it.get('filename'):
        attachment = f"<p class='muted'>附件：{esc(it['filename'])}（本次修改不换附件）</p>"
    body = (f"<div class='card'><h3>修改作业</h3>"
            + (f"<p role='status'>{esc(msg)}</p>" if msg else '')
            + f"<form method='post' action='/item/edit'>"
            f"<input type='hidden' name='id' value='{it['id']}'>"
            f"<input type='hidden' name='return_to' value='{esc(back)}'>"
            "<label class='form-field' for='edit-title'>标题</label>"
            f"<input id='edit-title' name='title' value='{esc(it['title'])}' required>"
            "<label class='form-field' for='edit-subject'>学科</label>"
            f"<select id='edit-subject' name='subject'>{subj_options}</select>"
            "<label class='form-field' for='edit-kind'>类型</label>"
            f"<select id='edit-kind' name='kind'>{kind_options}</select>"
            "<label class='form-field' for='edit-body'>文字内容</label>"
            f"<textarea id='edit-body' name='body' rows='4'>{esc(it['body'] or '')}</textarea>"
            "<label class='form-field' for='edit-link'>原链接</label>"
            f"<input id='edit-link' name='link_url' type='url' value='{esc(it['link_url'] or '')}' placeholder='https://…'>"
            "<label class='form-field' for='edit-due'>截止日期（可选）</label>"
            f"<input id='edit-due' name='due' type='date' value='{esc(it['due'] or '')}'>"
            + due_field_shortcuts("edit-due") +
            "<label class='form-field' for='edit-visible'>到这个时间才显示（可选）</label>"
            f"<input id='edit-visible' name='visible_at' type='datetime-local' value='{esc(it['visible_at'] or '')}'>"
            "<label style='display:flex;gap:10px;align-items:center;min-height:48px'>"
            f"<input type='checkbox' name='pinned' {'checked' if it['pinned'] else ''}> 置顶提醒</label>"
            + attachment
            + "<button class='full'>保存修改</button></form></div>"
            f"<p><a class='back' href='{esc(back)}'>← 不改了，回去</a></p>")
    return page("修改作业 - 作业板", body)


def student_item_delete_page(it):
    """学生删自己作业的确认页：删除不可逆，点进来只确认，不直接删。"""
    attachment = f"<p class='muted'>附件：{esc(it['filename'])}（删除时会一并删掉）</p>" if it.get('filename') else ""
    body = (f"<div class='card'><h3>确认删除这条作业吗？</h3>"
            f"<p>{esc(it['title'])}</p>"
            "<p class='muted'>删除后无法恢复，家长也找不回来。</p>"
            + attachment
            + f"<form method='post' action='/item/delete'>"
            f"<input type='hidden' name='id' value='{it['id']}'>"
            "<button class='danger full'>确认删除</button></form></div>"
            f"<p><a class='back' href='/item?id={it['id']}'>← 不删了，回去</a></p>")
    return page("删除作业 - 作业板", body)


def api_token_ok(token):
    """外部 AI 令牌是否有效：环境变量令牌或管理页生成的数据库令牌（只存哈希）二者任一对上即算。"""
    if not token:
        return False
    if API_TOKEN and token == API_TOKEN:
        return True
    try:
        conn = db()
        row = conn.execute("SELECT 1 FROM api_tokens WHERE token_hash=?",
                           (hashlib.sha256(token.encode()).hexdigest(),)).fetchone()
        conn.close()
        return bool(row)
    except sqlite3.OperationalError:
        return False


def has_any_api_token():
    if API_TOKEN:
        return True
    try:
        conn = db()
        n = conn.execute("SELECT COUNT(*) FROM api_tokens").fetchone()[0]
        conn.close()
        return n > 0
    except sqlite3.OperationalError:
        return False


def api_token_status():
    env = bool(API_TOKEN)
    created = ""
    try:
        conn = db()
        row = conn.execute("SELECT created FROM api_tokens ORDER BY created DESC LIMIT 1").fetchone()
        conn.close()
        if row:
            created = row[0]
    except sqlite3.OperationalError:
        pass
    return env, created


def admin_api_token_page(new_token=""):
    env, created = api_token_status()
    status = (f"<p class='muted'>环境变量令牌：{'已配置' if env else '未配置'}；"
              f"管理页生成的令牌：{'已生成，生成时间 ' + esc(created) if created else '未生成'}。</p>"
              "<p class='muted'>令牌允许查列表、读取可见内容和创建条目，不能删除、管理孩子或学科；"
              "生成新令牌会使旧的数据库令牌失效，环境变量令牌不受影响。</p>")
    shown = ""
    if new_token:
        shown = (f"<div class='card'><h3>新令牌（只显示这一次）</h3>"
                 f"<p style='word-break:break-all'><code>{esc(new_token)}</code></p>"
                 "<p class='muted'>复制后妥善保存，刷新页面就不再显示；丢了就重新生成一个。</p></div>")
    body = (admin_top("/admin", "← 回管理")
            + "<h3>API 令牌（给 AI 用）</h3>" + status + shown
            + "<form method='post' action='/admin/api-token/generate' style='margin:12px 0'>"
            + "<button>生成新令牌</button></form>"
            + "<form method='post' action='/admin/api-token/revoke' style='margin:12px 0'>"
            + "<button class='danger'>吊销数据库令牌</button></form>"
            + "<details class='card'><summary style='cursor:pointer;min-height:48px;display:flex;align-items:center'>给 AI 的配置（点开看）</summary>"
            + "<p class='muted'>把 HOST 换成这台服务器的地址；局域网用 LAN 地址，Tailscale 用 Tailscale 地址，"
            + "公开域名使用 HTTPS；网页和 AI 录入需要登录，外部 API 仍使用 X-API-Token。</p>"
            + "<pre style='white-space:pre-wrap;word-break:break-all;font-size:14px'>"
            + "GET http://HOST/api/lists\n"
            + "  Header: X-API-Token: &lt;令牌&gt;\n"
            + "POST http://HOST/api/items\n"
            + "  Header: X-API-Token: &lt;令牌&gt;\n"
            + "  表单：subject=学科名（必须和 lists 里的完全一致），child_id=孩子 id，\n"
            + "  title、kind、body、due(YYYY-MM-DD)、file=文件（可选）</pre></details>")
    return page("API 令牌 - 作业板", body)


def validate_draft(raw, subjects, children, default_child=0):
    """LLM / 粘贴 JSON 来的草稿只做校验和归一，不直接入库；学科、孩子对不上就留空，等用户在草稿卡里手选。"""
    if not isinstance(raw, dict):
        return {"title": "", "subject": "", "kind": "", "child_id": default_child, "due": "", "body": ""}
    subject = (raw.get("subject") or "").strip()
    if subject not in subjects:
        subject = ""
    kind = (raw.get("kind") or "").strip()
    if kind not in KINDS:
        kind = ""
    child_id = default_child
    try:
        cid = int(raw.get("child_id") or 0)
        if cid == 0 or any(c["id"] == cid for c in children):
            child_id = cid
    except (ValueError, TypeError):
        pass
    if raw.get("child_name"):
        for c in children:
            if c["name"] == (raw.get("child_name") or "").strip():
                child_id = c["id"]
    due = (raw.get("due") or "").strip()
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", due):
        due = ""
    return {"title": (raw.get("title") or "").strip(),
            "subject": subject, "kind": kind, "child_id": child_id,
            "due": due, "body": (raw.get("body") or "").strip()}


def ai_default_due(day=None):
    day = date.fromisoformat(day or today())
    return (day + timedelta(days=2) if day.weekday() == 4 else day).isoformat()


def numbered_entries(text):
    """Recognize sequential task lists, not page numbers, decimals or dates.

    Accept 1. / 1、 / 1) / (1) / （1） and whitespace-delimited 1 task 2 task.
    At least two nonempty entries starting at 1 are required; numeric-only lists
    (e.g. 第 1 2 3 题) and discontinuous numbers stay untouched for the model.
    """
    pattern = r"(?<![0-9A-Za-z_.])(?:[（(](\d{1,2})[）)]|([0-9]{1,2})[、．.)）](?!\d)|([0-9]{1,2})(?=\s+[^\d\s]))"
    matches = list(re.finditer(pattern, text))
    if len(matches) < 2:
        return None
    numbers = [int(next(g for g in m.groups() if g is not None)) for m in matches]
    if numbers != list(range(1, len(numbers) + 1)):
        return None
    entries = [text[m.end():matches[i + 1].start() if i + 1 < len(matches) else len(text)].strip(' \t\r\n;；')
               for i, m in enumerate(matches)]
    if any(not entry or not re.search(r'[^\d\s、，,。.;；:：()（）-]', entry) for entry in entries):
        return None
    return text[:matches[0].start()].strip(), entries


def call_llm_parse(text, image_bytes, image_ctype, default_child=None):
    numbered = numbered_entries(text)
    normalized = text
    if numbered:
        prefix, entries = numbered
        normalized = prefix + "\n" + "\n".join(f"{i}. {entry}" for i, entry in enumerate(entries, 1))
    ok, err, drafts = _call_llm_parse_once(normalized, image_bytes, image_ctype, default_child)
    if not ok or not numbered or image_bytes or len(drafts) >= len(numbered[1]):
        return ok, err, drafts
    # If the model still merged numbered tasks, parse each source task separately.
    # Keep shared subject/date context, but never clone a merged task's due date.
    # The fallback creates editable drafts only; no database write occurs here.
    from concurrent.futures import ThreadPoolExecutor
    from contextvars import copy_context
    prefix, entries = numbered
    def parse_entry(entry):
        content = (f"共同背景（适用于本条）：{prefix}\n" if prefix else "") + "本条独立任务：" + entry
        return _call_llm_parse_once(content, None, image_ctype, default_child)
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(copy_context().run, parse_entry, entry) for entry in entries]
        results = [future.result() for future in futures]
    combined = []
    for success, error, result in results:
        if not success:
            return False, error, result
        if not result:
            return False, "llm_empty_draft", "有编号任务未生成草稿，请重试；尚未创建任何作业。"
        combined.extend(result)
    return True, "", combined


def _call_llm_parse_once(text, image_bytes, image_ctype, default_child=None):
    """调 OpenAI 兼容的聊天接口做解析；没配 key 就明确返回未配置，不假装解析成功。"""
    import base64
    import urllib.error
    import urllib.request
    if not LLM_API_KEY:
        return False, "llm_not_configured", "未配置 LLM_API_KEY，改用下面的粘贴 JSON，或在部署环境里设 LLM_API_KEY。"
    model = LLM_VISION_MODEL if (image_bytes and LLM_VISION_MODEL) else LLM_MODEL
    system = ("你是作业登记解析器，只输出 JSON 数组，不要输出任何其他文字或 Markdown。"
              "每项字段：title（标题）、subject（学科，必须是下面列表里的原样字符串，对不上就留空）、"
              "kind（notice/homework/material/answer/listening/announcement，对不上就留空）、"
              "child_id（页面选定的孩子 id）、due（YYYY-MM-DD，没有明确日期就留空，由服务端为作业填入默认截止日）、body（正文）。"
              f"今天是 {today()}，相对日期（明天、下周五等）要换算成绝对日期。"
              f"未说明日期时 due 留空，不猜测日期；服务端会为作业填 {ai_default_due()}（通常当天，周五登记则周日）。明确日期优先，不得把明确周五改成周日。"
              "同一行的多个独立任务也必须拆开，不能只按换行或学科拆分。"
              "例如‘语文：1.抄写生字 2.背诵课文 3.阅读课外书’必须输出三项；1、2、3、(1)(2)、1 任务 2 任务等同理。"
              "每个编号任务独立保留所属学科、正文与截止日期；页码、题号范围（第1、2、3题）、小数和日期不要误拆。"
              f"学科列表：{json.dumps(get_subjects(), ensure_ascii=False)}。"
              f"孩子列表：{json.dumps(view_children(), ensure_ascii=False)}。")
    if default_child is not None:
        target = child_name(view_children(), default_child) if default_child else "共享"
        system += (f"本次登记对象已由用户在页面选定：{target}（child_id={default_child}）。"
                   "所有草稿都使用此 child_id，不根据正文姓名猜测或改变归属，用户会在核对页自行修改。")
    if image_bytes:
        mime = image_ctype if (image_ctype or "").startswith("image/") else "image/jpeg"
        b64 = base64.b64encode(image_bytes).decode()
        content = [{"type": "text", "text": text or "请解析这张图里的作业和通知，按学科拆成多条。"},
                   {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}}]
    else:
        content = text
    payload = json.dumps({"model": model, "temperature": 0.2,
                          "messages": [{"role": "system", "content": system},
                                       {"role": "user", "content": content}]}).encode()
    req = urllib.request.Request(LLM_BASE_URL.rstrip("/") + "/chat/completions", data=payload, method="POST")
    req.add_header("Authorization", "Bearer " + LLM_API_KEY)
    req.add_header("Content-Type", "application/json")
    # Groq/Cloudflare rejects Python's default User-Agent with 403; use an honest app UA.
    req.add_header("User-Agent", "school-board/1.0")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return False, "llm_error", f"模型接口返回 {e.code}，检查 LLM_BASE_URL / LLM_MODEL / key 是否正确。"
    except Exception:
        return False, "llm_error", "模型服务连接失败，请检查配置或改用粘贴 JSON。"
    try:
        content_out = data["choices"][0]["message"]["content"]
    except Exception:
        return False, "llm_bad_json", "模型返回格式不对，换个模型或重试一次。"
    try:
        start, end = content_out.index("["), content_out.rindex("]") + 1
        raw_list = json.loads(content_out[start:end])
    except Exception:
        return False, "llm_bad_json", "模型没有返回可解析的 JSON 数组，重试一次或改用粘贴 JSON。"
    if not isinstance(raw_list, list):
        return False, "llm_bad_json", "模型返回的不是数组，重试一次或改用粘贴 JSON。"
    subjects, children = get_subjects(), view_children()
    drafts = [validate_draft(r, subjects, children, default_child or 0) for r in raw_list]
    for draft in drafts:
        if draft["kind"] == "homework" and not draft["due"]:
            draft["due"] = ai_default_due()
    if default_child is not None:
        for draft in drafts:
            draft["child_id"] = default_child
    return True, "", drafts


def call_speech_transcribe(audio_bytes, audio_ctype):
    """OpenAI-compatible multipart transcription, in memory; never store raw recordings."""
    import urllib.error
    import urllib.request
    if not STT_API_KEY:
        return False, "stt_not_configured", "未配置 STT_API_KEY，请先配置语音服务，或改用文字 / 照片。"
    mime = (audio_ctype or "").split(";", 1)[0].strip().lower()
    if mime not in AUDIO_TYPES:
        return False, "unsupported_audio", "不支持这种音频格式，请使用 WebM、MP4/M4A、WAV、MP3 或 Ogg。"
    if not audio_bytes:
        return False, "empty_audio", "没有录到声音，请重新录音。"
    if len(audio_bytes) > MAX_AUDIO_BYTES:
        return False, "audio_too_large", "音频最大 10MB，请缩短录音。"
    boundary = "SchoolBoardSpeech" + secrets.token_hex(16)
    parts = []
    for name, value in (("model", STT_MODEL), ("response_format", "json")):
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    parts.append((f'--{boundary}\r\nContent-Disposition: form-data; name="file"; '
                  f'filename="recording.{AUDIO_TYPES[mime]}"\r\nContent-Type: {mime}\r\n\r\n').encode())
    parts.extend([audio_bytes, f'\r\n--{boundary}--\r\n'.encode()])
    req = urllib.request.Request(STT_BASE_URL.rstrip("/") + "/audio/transcriptions",
                                 data=b"".join(parts), method="POST")
    req.add_header("Authorization", "Bearer " + STT_API_KEY)
    req.add_header("Content-Type", "multipart/form-data; boundary=" + boundary)
    # Groq/Cloudflare rejects Python's default User-Agent with 403; use an honest app UA.
    req.add_header("User-Agent", "school-board/1.0")
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return False, "stt_error", f"语音服务返回 {e.code}，请检查 STT 配置及音频格式支持。"
    except Exception:
        # Do not echo upstream response bodies, URLs or credentials into the page.
        return False, "stt_error", "语音服务连接失败或返回无效数据，请重试或改用文字。"
    text = result.get("text") if isinstance(result, dict) else None
    if not isinstance(text, str) or not text.strip():
        return False, "empty_transcript", "未识别到文字，请靠近麦克风重新录音，或改用文字。"
    return True, "", text.strip()


def ai_entry_html(subjects, children):
    """登记页 AI 录入卡：文字 / 拍照先解析成草稿，逐条核对后批量创建；粘贴 JSON 是不花 API 钱的免费路径。"""
    lists_json = json.dumps({"subjects": subjects, "children": children, "locked_child": (VIEW_SESSION.get() or {}).get("role") == "student", "default_due": ai_default_due()}, ensure_ascii=False).replace("<", "\\u003c")
    js = r"""
var lists = JSON.parse(document.getElementById('sb-lists').textContent);
var kinds = [['notice','通知'],['homework','作业'],['material','学习资料'],['answer','答案'],['listening','听力'],['announcement','提醒']];
function mk(tag, text) { var e = document.createElement(tag); if (text !== undefined) e.textContent = text; return e; }
function sel(options, value) { var s = mk('select'); options.forEach(function(o) { var op = mk('option', o[1]); op.value = o[0]; if (String(o[0]) === String(value)) op.selected = true; s.appendChild(op); }); return s; }
function renderDrafts(drafts) {
  var box = document.getElementById('ai-drafts'); if (!arguments[1]) box.innerHTML = '';
  drafts.forEach(function(d) {
    var card = mk('div'); card.className = 'card draft-card'; card.style.margin = '12px 0';
    var chk = mk('input'); chk.type = 'checkbox'; chk.checked = true; chk.style.width = '22px'; chk.style.height = '22px';
    var title = mk('input'); title.value = d.title || ''; title.placeholder = '标题';
    var subj = sel([['','学科（必选）']].concat(lists.subjects.map(function(s) { return [s, s]; })), d.subject || '');
    var kind = sel([['','类型（可选）']].concat(kinds), d.kind || '');
    var child = sel([['','请选择孩子']].concat(lists.children.map(function(c) { return [String(c.id), c.name]; })), d.child_id || '');
    if (lists.locked_child) { child = mk('input'); child.type = 'hidden'; child.value = (d.child_id === undefined || d.child_id === null || d.child_id === '') ? lists.children[0].id : d.child_id; }
    var due = mk('input'); due.type = 'date'; due.value = d.due || '';
    var body = mk('textarea'); body.value = d.body || ''; body.placeholder = '正文';
    var del = mk('button'); del.className = 'danger small'; del.textContent = '删这条草稿'; del.type = 'button';
    del.onclick = function() { card.remove(); };
    function field(text, input) { var label = mk('label', text); label.appendChild(input); card.appendChild(label); }
    var checkLabel = mk('label', ' 创建这条草稿'); checkLabel.prepend(chk); card.appendChild(checkLabel);
    field('标题', title); field('学科（必选）', subj); field('类型', kind); if (lists.locked_child) { card.appendChild(mk('p', '本次登记给 ' + lists.children[0].name)); card.appendChild(child); } else { field('给谁', child); } field('截止日期', due); field('正文', body);
    var error = mk('p'); error.className = 'draft-error'; error.setAttribute('role', 'alert'); card.appendChild(error); card.appendChild(del);
    card._draft = {chk: chk, title: title, subj: subj, kind: kind, child: child, due: due, body: body, error: error};
    box.appendChild(card);
    if (!d.subject) { error.textContent = '请选择学科后再创建。'; }
    if (lists.locked_child && String(child.value) !== String(lists.children[0].id)) { chk.checked = false; error.textContent = '这条草稿不属于当前本子，请删除后重新录入。'; }
  });
  document.getElementById('ai-status').textContent = drafts.length ? ('已生成 ' + drafts.length + ' 条草稿，核对后点批量创建。') : '没有生成草稿。';
}
// Voice and text share the same draft renderer, but voice never discards existing drafts.
window.sbVoiceDrafts = function(drafts) { renderDrafts(drafts, true); };
document.getElementById('ai-parse-btn').onclick = async function() {
  var btn = this; var st = document.getElementById('ai-status'); var fd = new FormData();
  fd.append('text', document.getElementById('ai-text').value);
  fd.append('child_id', document.getElementById('entry-child').value);
  var f = document.getElementById('ai-image').files[0]; if (f) fd.append('image', f);
  if (!document.getElementById('ai-text').value.trim() && !f) { st.textContent = '先写一句话或拍一张图。'; return; }
  var context = document.getElementById('entry-child'); context.disabled = true;
  btn.disabled = true; st.textContent = '解析中…';
  try {
    var r = await fetch('/api/ai-parse', {method: 'POST', body: fd}); var j = await r.json();
    if (j.ok) renderDrafts(j.drafts); else st.textContent = j.message || ('解析失败：' + (j.error || r.status));
  } catch (e) { st.textContent = '解析失败：' + e; }
  btn.disabled = false; context.disabled = false;
};
document.getElementById('ai-json-btn').onclick = function() {
  var st = document.getElementById('ai-status');
  try {
    var v = JSON.parse(document.getElementById('ai-json').value);
    var arr = Array.isArray(v) ? v : (v.drafts || []);
    if (!arr.length) { st.textContent = 'JSON 里没有数组或 drafts。'; return; }
    var subjects = lists.subjects;
    var drafts = arr.map(function(d) {
      var subj = subjects.indexOf(d.subject) >= 0 ? d.subject : '';
      var cid = parseInt(document.getElementById('entry-child').value, 10);
      if (lists.locked_child && Object.prototype.hasOwnProperty.call(d, 'child_id')) cid = d.child_id;
      return {title: d.title || '', subject: subj, kind: d.kind || '', child_id: cid, due: /^\d{4}-\d{2}-\d{2}$/.test(d.due || '') ? d.due : (d.kind === 'homework' ? lists.default_due : ''), body: d.body || ''};
    });
    renderDrafts(drafts);
  } catch (e) { st.textContent = 'JSON 解析失败：' + e; }
};
document.getElementById('ai-create-btn').onclick = async function() {
  var btn = this; var st = document.getElementById('ai-status');
  var cards = Array.prototype.slice.call(document.querySelectorAll('#ai-drafts .card'));
  var drafts = [];
  var selected = cards.filter(function(card) { return card._draft && card._draft.chk.checked; });
  selected.forEach(function(card) { var d = card._draft; d.error.textContent = ''; card.classList.remove('has-error'); drafts.push({title: d.title.value, subject: d.subj.value, kind: d.kind.value, child_id: parseInt(d.child.value, 10) || 0, due: d.due.value, body: d.body.value}); });
  if (!drafts.length) { st.textContent = '没有勾选的草稿。'; return; }
  var controls = Array.from(document.querySelectorAll('#ai-entry button, #ai-entry input, #ai-entry select, #ai-entry textarea'));
  var disabledBefore = controls.map(function(c) { return c.disabled; });
  controls.forEach(function(c) { c.disabled = true; });
  var uncertain = false; st.textContent = '创建中…';
  try {
    var r = await fetch('/api/ai-batch', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({drafts: drafts})});
    var j = await r.json();
    if (j.ok && Array.isArray(j.created) && Array.isArray(j.failed)) {
      j.created.forEach(function(result) { if (selected[result.index]) selected[result.index].remove(); });
      j.failed.forEach(function(result) { var card = selected[result.index]; if (card) { card.classList.add('has-error'); card._draft.error.textContent = result.message || result.error || '创建失败，请修改后重试。'; } });
      st.textContent = '已创建 ' + j.created.length + ' 条，失败 ' + j.failed.length + ' 条。失败及未勾选的草稿已保留。';
    }
    else st.textContent = '批量创建失败：' + (j.error || r.status);
  } catch (e) { uncertain = true; st.textContent = '创建结果未确认，草稿已保留。请先到本子里检查，避免重复创建；核对后重新打开登记页。'; }
  controls.forEach(function(c, i) { c.disabled = disabledBefore[i]; });
  btn.disabled = uncertain;
};
"""
    configured = bool(LLM_API_KEY)
    model_note = ("文字或照片会发给已配置的模型服务商，可能产生 API 费用。" if configured
                  else "尚未配置模型，文字 / 拍照识别不可用。可展开下方入口粘贴 JSON，生成草稿后核对。")
    html = ("<div class='ai-input-card'><p class='entry-step'>1 / 录入内容</p><h2>先识别，再核对</h2>"
            "<p class='muted'>识别后生成草稿，确认之前不会创建作业。想用语音时，用输入法的语音输入转成文字再粘贴进来，识别更准。</p>"
            "<div class='ai-input-grid'>"
            "<div><label class='form-field' for='ai-text'>写一句、拍张照</label><textarea id='ai-text' placeholder='例如：语文：1.抄写生字 2.背诵课文 3.阅读15分钟（不用换行）'></textarea>"
            "<label class='form-field' for='ai-image'>照片（可选，最大 10MB）</label><input id='ai-image' type='file' accept='image/*' aria-label='拍照或选图'>"
            f"<p class='form-note'>{model_note}</p>"
            f"<button id='ai-parse-btn' type='button' {'disabled' if not configured else ''}>识别文字 / 照片</button></div></div></div>"
            "<div class='ai-review'><p class='entry-step'>2 / 核对后创建</p><h2>核对作业草稿</h2>"
            "<p class='muted'>检查孩子、学科和截止日期；未指定日期的作业默认当天，周五登记默认周日。明确日期优先，可修改或清空。</p>"
            "<p id='ai-status' class='muted' role='status' aria-live='polite'></p>"
            "<div id='ai-drafts'></div>"
            "<button id='ai-create-btn' type='button'>确认并创建已勾选作业</button></div>"
            "<details class='entry-tools'><summary style='cursor:pointer;min-height:48px;display:flex;align-items:center'>粘贴 AI 结果 JSON（免费路径，点开看）</summary>"
            "<label class='form-field' for='ai-json'>JSON 草稿数组</label><textarea id='ai-json' placeholder='[{\"title\":\"数学练习册第10页\",\"subject\":\"数学\",\"kind\":\"homework\",\"child_id\":1,\"due\":\"2026-10-28\",\"body\":\"\"}]'></textarea>"
            "<button id='ai-json-btn' type='button'>用粘贴的 JSON 生成草稿</button></details>"
            "<script type='application/json' id='sb-lists'>__LISTS_JSON__</script>"
            "<script>" + js + "</script>")
    return html.replace("__LISTS_JSON__", lists_json)



class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send_html(self, data, status=200, cookie=None):
        self.send_response(status)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Type", "text/html; charset=utf-8")
        if cookie:
            for value in ([cookie] if isinstance(cookie, str) else cookie):
                self.send_header("Set-Cookie", value)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def redirect(self, loc, cookie=None):
        self.send_response(303)
        self.send_header("Location", loc)
        if cookie:
            for value in ([cookie] if isinstance(cookie, str) else cookie):
                self.send_header("Set-Cookie", value)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def authorize(self, path, post=False):
        self.session = get_session(self)
        # Legacy admin has parent privileges, including AI, for compatibility.
        if is_admin(self):
            self.session = {'role': 'parent', 'child_id': 0}
        VIEW_SESSION.set(self.session)
        student = self.session and self.session['role'] == 'student'
        if path.startswith('/admin') and not (post and path == '/admin/add') and student:
            self.send_html(error_page('无法访问管理页', '请回首页继续查看作业。'), 403)
            return False
        if post and path.startswith('/admin/') and path not in ('/admin/login', '/admin/add') and not self.session:
            self.redirect('/admin')
            return False
        if path in ('/api/ai-parse', '/api/ai-batch', '/api/ai-voice') and not self.session:
            self.send_json({'ok': False, 'error': 'unauthorized'}, 401)
            return False
        protected = path in ('/', '/register', '/item', '/item/edit', '/item/delete', '/item/due', '/done', '/add', '/admin/add', '/logout') or path.startswith('/uploads/')
        if protected and not self.session:
            self.redirect('/login')
            return False
        return True

    def can_view_item(self, item):
        if not item:
            return False
        return not self.session or self.session['role'] != 'student' or item['child_id'] in (0, self.session['child_id'])

    def do_GET(self):
        u = urlparse(self.path)
        params = parse_qs(u.query)
        if not self.authorize(u.path):
            return
        if u.path == '/login':
            if self.session:
                self.redirect('/admin' if self.session['role'] == 'parent' else '/')
            else:
                self.send_html(login_page())
            return
        if u.path in ("/static/paper.css", "/static/paper.js", "/static/entry.css", "/static/media.js", "/static/media.css", "/static/pdfjs/pdf.mjs", "/static/pdfjs/pdf.worker.mjs", "/manifest.json", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png", "/icon.svg", "/sw.js"):
            ctype = {"json": "application/manifest+json", "js": "application/javascript",
                     "svg": "image/svg+xml", "png": "image/png", "mjs": "application/javascript", "css": "text/css"}.get(u.path.rsplit(".", 1)[-1], "image/png")
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
            raw_child = params.get("child", [None])[0]
            child = None if raw_child is None else (int(raw_child) if raw_child.isdigit() else -1)
            if self.session['role'] == 'student':
                child = self.session['child_id']
            self.send_html(register_page("", params.get("subject", [""])[0], child))
            return
        if u.path == "/api/lists":
            if has_any_api_token():
                token = self.headers.get("X-API-Token", "") or params.get("token", [""])[0]
                if not api_token_ok(token):
                    self.send_json({"ok": False, "error": "unauthorized"}, 401)
                    return
            self.send_json({"ok": True,
                            "children": [{"id": c["id"], "name": c["name"]} for c in get_children()],
                            "subjects": get_subjects(),
                            "kinds": [{"code": k, "label": v} for k, v in KINDS.items()]})
            return
        if u.path == "/api":
            self.send_json({"ok": True, "post": "/api/items",
                            "lists": "/api/lists",
                            "ai_parse": "/api/ai-parse (login session required)",
                            "ai_batch": "/api/ai-batch (login session required)",
                            "ai_voice": "/api/ai-voice (login session required, child_id + audio multipart, no auto-create)",
                            "fields": "title(可选，不填用文件名), subject, subject_new, kind(不填时：音频->听力，PDF->学习资料，其余->通知), body, link_url, due, visible_at, pinned, child_id",
                            "example": "curl -F \"file=@数学练习.pdf\" -F \"subject=数学\" -F \"child_id=1\" http://HOST:8765/api/items"})
            return
        if u.path == "/api/items":
            if has_any_api_token():
                token = self.headers.get("X-API-Token", "") or params.get("token", [""])[0]
                if not api_token_ok(token):
                    self.send_json({"ok": False, "error": "unauthorized"}, 401)
                    return
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
            if not self.can_view_item(it) or (it["visible_at"] and it["visible_at"] > now_dt()):
                self.send_html(error_page("没找到这条内容", "它可能不存在，或者还没到设定的显示时间。"), 404)
                return
            try:
                child = int(params.get("child", ["0"])[0])
            except ValueError:
                child = 0
            if self.session['role'] == 'student':
                child = self.session['child_id']
            back = (f"<p><a class='back' href='/{qs(child, subject=it['subject'])}'>"
                    f"← 回{esc(it['subject'])}</a></p>")
            self.send_html(contextual_page(it["title"], back + item_card(it, view_children(), detail=True, child=child), child))
            return
        if u.path == "/admin":
            if not is_admin(self):
                form = ("<div class='card'><h3>家长登录</h3>"
                        "<form method='post' action='/admin/login'>"
                        "<input type='password' name='password' aria-label='管理密码' placeholder='管理密码' required>"
                        "<button class='full'>登录</button></form></div>")
                self.send_html(page("家长登录", form))
                return
            self.send_html(admin_page())
            return
        if u.path in ("/admin/children", "/admin/subjects", "/admin/items", "/admin/api-token"):
            if not is_admin(self):
                self.redirect("/admin")
                return
            if u.path == "/admin/api-token":
                self.send_html(admin_api_token_page())
            elif u.path == "/admin/children":
                self.send_html(admin_children_page())
            elif u.path == "/admin/subjects":
                self.send_html(admin_subjects_page())
            else:
                raw = params.get("child", [""])[0]
                if raw == "":
                    self.send_html(admin_items_page(None))
                else:
                    try:
                        self.send_html(admin_items_page(int(raw)))
                    except ValueError:
                        self.send_html(admin_items_page(None))
            return
        if u.path in ("/item/edit", "/item/delete"):
            try:
                it = get_item(int(params.get("id", ["0"])[0]))
            except ValueError:
                it = None
            if not item_edit_allowed(it, self.session):
                self.send_html(error_page("没找到这条内容", "它可能不存在，或者不属于你的本子。"), 404)
                return
            if u.path == "/item/edit":
                context_child = params.get('child', [''])[0]
                return_to = f"/item?id={it['id']}&child={context_child}" if context_child.isdigit() else ''
                self.send_html(student_item_edit_page(it, return_to=return_to))
            else:
                self.send_html(student_item_delete_page(it))
            return
        if u.path == "/admin/item/edit":
            if not is_admin(self):
                self.redirect("/admin")
                return
            try:
                it = get_item(int(params.get("id", ["0"])[0]))
            except ValueError:
                it = None
            if not it:
                self.send_html(error_page("没找到这条内容", "它可能已被删除，回到登记项目管理重新找一下。"), 404)
                return
            self.send_html(admin_item_edit_page(it))
            return
        if u.path.startswith("/uploads/"):
            name = unquote(urlparse(self.path).path[len("/uploads/"):])
            if "/" in name or ".." in name or not os.path.isfile(os.path.join(UPLOAD_DIR, name)):
                self.send_html(error_page("文件找不到了", "这个附件可能已被删除，回到首页重新找一下。"), 404)
                return
            if self.session['role'] == 'student':
                with session_db() as conn:
                    owners = conn.execute('SELECT * FROM items WHERE stored=?', (name,)).fetchall()
                if not any(self.can_view_item(row) and (not row['visible_at'] or row['visible_at'] <= now_dt()) for row in owners):
                    self.send_html(error_page('文件找不到了', '这个附件可能已被删除，回到首页重新找一下。'), 404)
                    return
            path = os.path.join(UPLOAD_DIR, name)
            mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
            size = os.path.getsize(path)
            start, end, partial = 0, size - 1, False
            requested_range = self.headers.get("Range", "")
            if requested_range:
                match = re.fullmatch(r"bytes=(\d*)-(\d*)", requested_range)
                valid = bool(match and any(match.groups()) and size)
                if valid:
                    left, right = match.groups()
                    start = int(left) if left else max(0, size - int(right))
                    end = min(size - 1, int(right)) if left and right else size - 1
                    valid = start <= end and start < size and (left or int(right) > 0)
                if not valid:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                partial = True
            self.send_response(206 if partial else 200)
            self.send_header("Content-Type", mime)
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Accept-Ranges", "bytes")
            if partial:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            if parse_qs(urlparse(self.path).query).get("download") or mime in ('text/html', 'image/svg+xml', 'application/xhtml+xml', 'application/xml', 'text/xml'):
                self.send_header('Content-Security-Policy', "sandbox; default-src 'none'")
                it = None
                conn = db()
                row = conn.execute("SELECT filename FROM items WHERE stored=?", (name,)).fetchone()
                conn.close()
                if row:
                    it = row[0]
                if it:
                    self.send_header("Content-Disposition",
                                     "attachment; filename*=UTF-8''" + quote(it))
            self.send_header("Content-Length", str(end - start + 1))
            self.end_headers()
            with open(path, "rb") as file:
                file.seek(start)
                remaining = end - start + 1
                try:
                    while remaining > 0:
                        chunk = file.read(min(65536, remaining))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    pass  # Seeking/closing media cancels the previous browser request.
            return
        self.send_html(error_page("这个页面不存在", "地址可能打错了，回到首页重新找一下。"), 404)

    def read_form(self):
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length > MAX_FILE_BYTES + 1024 * 1024:
            return {}, None, None, ""
        ctype = self.headers.get("Content-Type", "")
        if ctype.startswith("multipart/form-data"):
            return parse_multipart(self, length, ctype)
        if ctype.startswith("application/json"):
            try:
                obj = json.loads(self.rfile.read(length).decode("utf-8"))
                return {k: str(v) for k, v in obj.items()}, None, None, ""
            except Exception:
                return {}, None, None, ""
        _fields, _fb, _fn = parse_urlencoded(self, length)
        return _fields, _fb, _fn, ""

    def do_add(self, redirect_to):
        fields, file_bytes, filename, file_ctype = self.read_form()
        item_id, title = create_item(fields, file_bytes, filename, file_ctype)
        if redirect_to == "api":
            return item_id, title
        self.redirect(redirect_to)
        return item_id, title

    def valid_entry_child(self, fields, token_api=False):
        try:
            child = int(fields.get("child_id") or fields.get("child") or 0)
        except (TypeError, ValueError):
            return False
        if not token_api and self.session and self.session['role'] == 'student' and child != self.session['child_id']:
            return False
        return any(c["id"] == child for c in get_children())

    def do_POST(self):
        u = urlparse(self.path)
        if not self.authorize(u.path, post=True):
            return
        # SameSite=Lax prevents cross-site form cookies; reject explicit foreign
        # Origins too (including sibling subdomains). Token APIs retain CLI behavior.
        origin = self.headers.get('Origin')
        if origin and u.path != '/api/items' and urlparse(origin).netloc != self.headers.get('Host'):
            self.send_html(error_page('请求无效', '请从本站页面重新操作。'), 403)
            return
        if u.path == '/login' and self.session:
            self.redirect('/admin' if self.session['role'] == 'parent' else '/')
            return
        if u.path in ('/logout', '/admin/logout'):
            revoke_session(self)
            self.redirect('/login',
                          [session_cookie(self, clear=True), 'admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'])
            return
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
        if u.path == "/api/ai-voice" and clen > MAX_AUDIO_BYTES + 64 * 1024:
            self.close_connection = True
            self.send_json({"ok": False, "error": "audio_too_large", "message": "音频最大 10MB，请缩短录音。"}, 413)
            return
        if u.path == "/api/items":
            if has_any_api_token():
                token = self.headers.get("X-API-Token", "") or parse_qs(urlparse(self.path).query).get("token", [""])[0]
                if not api_token_ok(token):
                    self.send_json({"ok": False, "error": "unauthorized"}, 401)
                    return
            fields, file_bytes, filename, file_ctype = self.read_form()
            if not self.valid_entry_child(fields, token_api=True):
                self.send_json({"ok": False, "error": "invalid_child", "message": "请选择有效的孩子；新登记不再支持共享。"}, 400)
                return
            item_id, title = create_item(fields, file_bytes, filename, file_ctype)
            self.send_json({"ok": True, "id": item_id, "title": title, "url": f"/item?id={item_id}"}, 201)
            return
        if u.path == "/api/ai-batch":
            try:
                raw = json.loads(self.rfile.read(clen).decode("utf-8")) if clen else {}
            except Exception:
                raw = {}
            drafts_in = raw.get("drafts") if isinstance(raw, dict) else None
            if not isinstance(drafts_in, list) or not drafts_in:
                self.send_json({"ok": False, "error": "empty drafts"}, 400)
                return
            subjects, children = get_subjects(), get_children()
            created, failed = [], []
            for index, raw_draft in enumerate(drafts_in):
                d = validate_draft(raw_draft, subjects, children, 0)
                if not self.valid_entry_child(d):
                    failed.append({"index": index, "draft": d, "error": "invalid_child", "message": "请选择有效的孩子；新登记不再支持共享。"})
                    continue
                if not d["subject"]:
                    failed.append({"index": index, "draft": d, "error": "subject required", "message": "请选择学科"})
                    continue
                item_id, title = create_item({"title": d["title"], "subject": d["subject"],
                                              "kind": d["kind"], "child_id": str(d["child_id"]),
                                              "due": d["due"], "body": d["body"]}, None, "")
                created.append({"index": index, "id": item_id, "title": title})
            self.send_json({"ok": True, "created": created, "failed": failed})
            return
        fields, file_bytes, filename, file_ctype = self.read_form()
        default_child = None
        if u.path in ("/api/ai-voice", "/api/ai-parse"):
            if not self.valid_entry_child(fields):
                self.send_json({"ok": False, "error": "invalid_child", "message": "请选择有效的孩子，再解析作业。"}, 400)
                return
            try:
                default_child = int(fields.get("child_id") or fields.get("child"))
            except (ValueError, TypeError):
                default_child = -1
            if default_child != 0 and not any(c["id"] == default_child for c in get_children()):
                self.send_json({"ok": False, "error": "invalid_child", "message": "登记对象已失效，请回首页重新选择本子。"}, 400)
                return
        if u.path == "/api/ai-voice":
            if not LLM_API_KEY or not STT_API_KEY:
                self.send_json({"ok": False, "error": "voice_not_configured",
                                "message": "语音需配置 STT_API_KEY 和 LLM_API_KEY，请改用文字或手动登记。"}, 503)
                return
            ok, err, transcript = call_speech_transcribe(file_bytes, file_ctype)
            if not ok:
                status = 413 if err == "audio_too_large" else (400 if err in ("empty_audio", "unsupported_audio") else 502)
                self.send_json({"ok": False, "error": err, "message": transcript}, status)
                return
            ok, err, result = call_llm_parse(transcript, None, "", default_child)
            if not ok:
                self.send_json({"ok": False, "error": err, "message": result, "transcript": transcript}, 502)
                return
            self.send_json({"ok": True, "transcript": transcript, "drafts": result})
            return
        if u.path == "/api/ai-parse":
            text = (fields.get("text") or "").strip()
            if file_bytes and len(file_bytes) > 10 * 1024 * 1024:
                self.send_json({"ok": False, "error": "image too large, max 10MB"}, 413)
                return
            if not text and not file_bytes:
                self.send_json({"ok": False, "error": "empty input"}, 400)
                return
            ok, err, result = call_llm_parse(text, file_bytes, file_ctype, default_child)
            if not ok:
                self.send_json({"ok": False, "error": err, "message": result},
                               503 if err == "llm_not_configured" else 502)
                return
            self.send_json({"ok": True, "drafts": result})
            return
        if u.path == "/item/due":
            try:
                it = get_item(int(fields.get('id', '0')))
            except ValueError:
                it = None
            if not item_edit_allowed(it, self.session) or it['kind'] != 'homework':
                self.send_html(error_page('没找到这条作业', '它可能不存在，或者不属于你的本子。'), 404)
                return
            presets = {key: value for key, _, value in due_presets()}
            preset = fields.get('preset', 'custom')
            due = (fields.get('due') or '').strip() if preset == 'custom' else presets.get(preset)
            if due is None or not valid_due_date(due):
                self.send_html(error_page('截止日期无效，未保存', '请返回后选择有效日期。'), 400)
                return
            with db() as conn:
                conn.execute('UPDATE items SET due=? WHERE id=?', (due, it['id']))
            self.redirect(notebook_return(fields.get('return_to', ''), f"/item?id={it['id']}"))
            return
        if u.path == "/done":
            try:
                item_id = int(fields.get("id", "0"))
            except ValueError:
                item_id = 0
            it = get_item(item_id)
            if not self.can_view_item(it) or (self.session['role'] == 'student' and it['visible_at'] and it['visible_at'] > now_dt()):
                self.send_html(error_page('没找到这条内容', '它可能不存在，或者还没到设定的显示时间。'), 404)
                return
            conn = db()
            conn.execute("UPDATE items SET done = 1 - done WHERE id=?", (item_id,))
            conn.commit()
            conn.close()
            ref = urlparse(self.headers.get("Referer", "") or "")
            back = ref.path + ("?" + ref.query if ref.query else "")
            self.redirect(back if back.startswith("/") else "/")
            return
        if u.path in ("/item/edit", "/item/delete"):
            try:
                item_id = int(fields.get("id", "0"))
            except ValueError:
                item_id = 0
            it = get_item(item_id)
            if not item_edit_allowed(it, self.session):
                self.send_html(error_page("没找到这条内容", "它可能不存在，或者不属于你的本子。"), 404)
                return
            if u.path == "/item/delete":
                if it["stored"]:
                    try:
                        os.remove(os.path.join(UPLOAD_DIR, it["stored"]))
                    except OSError:
                        pass
                conn = db()
                conn.execute("DELETE FROM items WHERE id=?", (item_id,))
                conn.commit()
                conn.close()
                self.redirect("/")
                return
            title = (fields.get("title") or "").strip()
            subject = fields.get("subject") or ""
            kind = fields.get("kind") or ""
            due = (fields.get("due") or "").strip()
            visible_at = (fields.get("visible_at") or "").strip()
            error = ""
            if not title:
                error = "标题不能为空，未保存。"
            elif subject not in get_subjects():
                error = "学科不存在，未保存。"
            elif kind not in KINDS:
                error = "类型不存在，未保存。"
            elif not valid_due_date(due):
                error = "截止日期格式不对，未保存。"
            elif visible_at and not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?", visible_at):
                error = "显示时间格式不对，未保存。"
            if error:
                draft = dict(it)
                draft.update(title=title, subject=subject, kind=kind,
                             body=fields.get("body") or "",
                             link_url=fields.get("link_url") or "", due=due,
                             visible_at=visible_at,
                             pinned=1 if fields.get("pinned") else 0)
                self.send_html(student_item_edit_page(draft, error, fields.get("return_to", "")))
                return
            conn = db()
            conn.execute("UPDATE items SET title=?, subject=?, kind=?, body=?, link_url=?,"
                         "due=?, visible_at=?, pinned=? WHERE id=?",
                         (title, subject, kind, fields.get("body") or "",
                          safe_link(fields.get("link_url")), due, visible_at,
                          1 if fields.get("pinned") else 0, item_id))
            conn.commit()
            conn.close()
            self.redirect(notebook_return(fields.get("return_to", ""), f"/item?id={item_id}"))
            return
        if u.path == '/login':
            with session_db() as conn:
                row = conn.execute('SELECT id,password_hash FROM children WHERE name=?', ((fields.get('name') or '').strip(),)).fetchone()
            # Dummy PBKDF2 keeps absent/unconfigured names on the same expensive path.
            stored = row['password_hash'] if row and row['password_hash'] else '00' * 16 + ':' + '00' * 32
            matches = password_matches(fields.get('password', ''), stored)
            if row and row['password_hash'] and matches:
                self.redirect('/', start_session(self, 'student', row['id']))
            else:
                self.send_html(login_page(True))
            return
        if u.path == "/admin/login":
            if hmac.compare_digest(fields.get("password", "").encode(), ADMIN_PASSWORD.encode()):
                self.redirect("/admin", start_session(self, 'parent'))
            else:
                self.send_html(error_page("密码不对", "管理密码不对，请重试。"))
            return
        if u.path in ("/add", "/admin/add"):
            # 登录后才能登记；学生提交不同 child_id 一致返回 400，不代改归属。
            if not self.valid_entry_child(fields):
                self.send_html(error_page("请选择孩子", "登记对象缺失或已失效。未保存内容，请返回登记页选择有效孩子；不再支持新建共享内容。"), 400)
                return
            item_id, title = create_item(fields, file_bytes, filename, file_ctype)
            try:
                child = int(fields.get("child_id") or 0)
            except ValueError:
                child = 0
            self.redirect("/admin" if u.path == "/admin/add" and self.session["role"] == "parent" else f"/{qs(child)}")
            return
        if not is_admin(self):
            self.send_response(403)
            self.end_headers()
            return
        if u.path == '/admin/child/password':
            try:
                cid = int(fields.get('id', '0'))
            except ValueError:
                cid = 0
            password = fields.get('password', '')
            clearing = fields.get('operation') == 'clear'
            if not clearing and len(password) < 6:
                self.send_html(admin_children_page('密码至少需要 6 位，尚未修改。'))
                return
            with session_db() as conn:
                exists = conn.execute('SELECT 1 FROM children WHERE id=?', (cid,)).fetchone()
                if exists:
                    conn.execute('UPDATE children SET password_hash=? WHERE id=?', ('' if clearing else password_hash(password), cid))
                    conn.execute('DELETE FROM sessions WHERE child_id=?', (cid,))
            self.send_html(admin_children_page(('密码已清除。' if clearing else '密码已更新。') if exists else '孩子不存在，尚未修改。'))
            return
        if u.path == "/admin/api-token/generate":
            token = "sb_" + secrets.token_urlsafe(24)
            conn = db()
            conn.execute("DELETE FROM api_tokens")
            conn.execute("INSERT INTO api_tokens VALUES (?,?)",
                         (hashlib.sha256(token.encode()).hexdigest(), now_dt()))
            conn.commit()
            conn.close()
            self.send_html(admin_api_token_page(token))
            return
        if u.path == "/admin/api-token/revoke":
            conn = db()
            conn.execute("DELETE FROM api_tokens")
            conn.commit()
            conn.close()
            self.redirect("/admin/api-token")
            return
        if u.path == "/admin/item/edit":
            try:
                item_id = int(fields.get("id", "0"))
            except ValueError:
                item_id = 0
            it = get_item(item_id)
            if not it:
                self.send_html(error_page("没找到这条内容", "它可能已被删除，回到登记项目管理重新找一下。"), 404)
                return
            title = (fields.get("title") or "").strip()
            subject = fields.get("subject") or ""
            kind = fields.get("kind") or ""
            try:
                child_id = int(fields.get("child_id") or 0)
            except ValueError:
                child_id = -1
            due = (fields.get("due") or "").strip()
            visible_at = (fields.get("visible_at") or "").strip()
            children = get_children()
            valid_children = [c["id"] for c in children] + ([0] if it["child_id"] == 0 else [])
            error = ""
            if not title:
                error = "标题不能为空，未保存。"
            elif subject not in get_subjects():
                error = "学科不存在，未保存。"
            elif kind not in KINDS:
                error = "类型不存在，未保存。"
            elif child_id not in valid_children:
                error = "归属孩子不存在，未保存。"
            elif not valid_due_date(due):
                error = "截止日期格式不对，未保存。"
            elif visible_at and not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?", visible_at):
                error = "显示时间格式不对，未保存。"
            if error:
                draft = dict(it)
                draft.update(title=title, subject=subject, kind=kind,
                             body=fields.get("body") or "",
                             link_url=fields.get("link_url") or "", due=due,
                             visible_at=visible_at,
                             pinned=1 if fields.get("pinned") else 0,
                             child_id=child_id)
                self.send_html(admin_item_edit_page(draft, error))
                return
            conn = db()
            conn.execute("UPDATE items SET title=?, subject=?, kind=?, body=?, link_url=?,"
                         "due=?, visible_at=?, pinned=?, child_id=? WHERE id=?",
                         (title, subject, kind, fields.get("body") or "",
                          safe_link(fields.get("link_url")), due, visible_at,
                          1 if fields.get("pinned") else 0, child_id, item_id))
            conn.commit()
            conn.close()
            self.redirect(f"/admin/items?child={child_id}")
            return
        if u.path == "/admin/delete":
            try:
                item_id = int(fields.get("id", "0"))
            except ValueError:
                item_id = 0
            it = get_item(item_id)
            child_id = it.get("child_id", 0) if it else 0
            if it and it["stored"]:
                try:
                    os.remove(os.path.join(UPLOAD_DIR, it["stored"]))
                except OSError:
                    pass
            conn = db()
            conn.execute("DELETE FROM items WHERE id=?", (item_id,))
            conn.commit()
            conn.close()
            self.redirect(f"/admin/items?child={child_id}")
            return
        if u.path == "/admin/child":
            name = (fields.get("name") or "").strip()
            if name:
                conn = db()
                conn.execute("INSERT OR IGNORE INTO children (name) VALUES (?)", (name,))
                conn.commit()
                conn.close()
            self.redirect("/admin/children")
            return
        if u.path == "/admin/child/delete":
            try:
                cid = int(fields.get("id", "0"))
            except ValueError:
                cid = 0
            conn = db()
            conn.execute("UPDATE items SET child_id=0 WHERE child_id=?", (cid,))
            conn.execute("DELETE FROM sessions WHERE child_id=?", (cid,))
            conn.execute("DELETE FROM children WHERE id=?", (cid,))
            conn.commit()
            conn.close()
            self.redirect("/admin/children")
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
                    # 重名：静默保留旧名，不报错、不卡住。
                    pass
                except sqlite3.OperationalError:
                    self.send_html(error_page("改名失败", "数据库正忙，请等一下再点一次改名。"))
                    return
                finally:
                    conn.close()
            self.redirect("/admin/children")
            return
        if u.path == "/admin/subject":
            name = (fields.get("name") or "").strip()
            if name:
                ensure_subject(name)
            self.redirect("/admin/subjects")
            return
        if u.path == "/admin/subject/delete":
            name = (fields.get("name") or "").strip()
            conn = db()
            n = conn.execute("SELECT COUNT(*) FROM items WHERE subject=?", (name,)).fetchone()[0]
            if n == 0:
                conn.execute("DELETE FROM subjects WHERE name=?", (name,))
            conn.commit()
            conn.close()
            self.redirect("/admin/subjects")
            return
        self.send_html(error_page("这个操作不存在", "回到首页重新操作一下。"), 404)


if __name__ == "__main__":
    init_db()
    print(f"作业板 http://127.0.0.1:{PORT}/  登记 /register  管理 /admin", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
