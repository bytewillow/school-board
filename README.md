# 作业簿 2.0

学生用的作业簿，做成可以装到手机、平板主屏幕上的 PWA：打开就知道今晚先写哪一项，记作业、拆步骤、专注计时、截止前推送提醒。家长可以管理多个孩子的本子。

这是对原 `app.py` 版本的整体重写（Node + TypeScript）。**对外接口和数据保持兼容**：`/api/*`、`X-API-Token`、环境变量、`data/` 目录都和旧版一样，直接指向原来的数据目录就能用，已登录的设备也不用重新登录。

## 快速开始

需要 Node.js 22.13 或更高（用到内置的 `node:sqlite`）。

```bash
npm install
npm run build          # 打包前端 + 编译服务端
ADMIN_PASSWORD=换成你的密码 npm start
# 打开 http://127.0.0.1:8765/
```

开发时开两个终端：

```bash
npm run dev            # 服务端，改代码自动重启（不跑推送定时器）
npm run dev:web        # 前端，http://127.0.0.1:5173/ ，接口自动转到 8765
```

Docker：

```bash
ADMIN_PASSWORD=换成你的密码 docker compose up -d --build
```

## 从旧版升级

1. **先备份** `data/` 目录。
2. 用同一个 `data/` 目录启动新版（Docker 里还是挂到 `/data`）。第一次启动会：
   - 在 `data/board.db.v1-backup` 留一份升级前的库；
   - 只给数据库**加**列和表，不删不改旧数据。旧版 `app.py` 仍然能读这个库，回滚时换回旧镜像即可（新加的步骤、专注记录、提醒设置旧版看不到）。
3. 旧的登录 cookie（`sb_session`、旧版 `admin`）、学生密码、API 令牌都继续有效。

把另一份数据合并进来（比如两台机器各有一份）：

```bash
npm run import -- --from /另一份/data
# 或者从正在运行的旧服务器通过 API 拉（拿不到定时显示、置顶和原创建时间）：
npm run import -- --url http://旧服务器:8765 --token sb_xxx --cookie "sb_session=家长登录后的值"
```

孩子按名字合并，条目全部追加，附件按文件名复制，重复导入会自动跳过。导入前会自动备份当前库。详见 [docs/MIGRATION.md](docs/MIGRATION.md)。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ADMIN_PASSWORD` | `admin123` | 家长管理密码，**部署前一定要改** |
| `DATA_DIR` | `./data` | 数据目录（`board.db` + `uploads/`） |
| `PORT` | `8765` | |
| `API_TOKEN` | 空 | 给外部 AI 用的令牌；也可以在管理页生成 |
| `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` / `LLM_VISION_MODEL` | 空 / DeepSeek / `deepseek-chat` / 空 | 拍照识别、粘贴文字识别作业 |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | 空 | 推送密钥。不填会自动生成并存进数据库；`npm run vapid` 可以生成一对 |
| `VAPID_SUBJECT` | `mailto:school-board@example.com` | 推送联系方式，**建议改成你自己的邮箱**，苹果推送会校验格式 |
| `TZ` | 系统时区 | 截止时间、提醒按这个时区算，Docker 默认 `Asia/Shanghai` |

## 装到手机，打开提醒

- **必须走 HTTPS**（局域网 IP 的 http 装不了、也收不到推送）。反向代理配置见 [docs/login.md](docs/login.md)。
- iPhone / iPad：用 Safari 打开 → 分享 → 添加到主屏幕 → 从主屏幕图标打开 → “我的 → 在这台设备上接收提醒”。需要 iOS / iPadOS 16.4 或更高。
- 安卓 / 电脑：Chrome、Edge 地址栏里点“安装”即可，提醒直接在“我的”里打开。
- 会推送的提醒：截止前 N 小时（早上交的作业改在前一晚 21:00）、每天固定时间的“今晚有几项”、专注计时结束。专注结束提醒由服务器在结束时刻发，所以切到别的 App 或锁屏也能收到。
- **做不到的**：锁屏上的实时倒计时（iOS 的“实时活动”只有原生 App 能用）。专注时会请求屏幕常亮，屏幕上一直显示倒计时。

## 对外接口（与旧版一致）

| 接口 | 说明 |
| --- | --- |
| `GET /api` | 接口索引 |
| `GET /api/lists` | 孩子、学科、类型；配置了令牌时需要 `X-API-Token` 或 `?token=` |
| `GET /api/items?child=&subject=` | 可见条目；返回字段与旧版完全一致 |
| `POST /api/items` | 新建条目，表单 / multipart / JSON，成功 201 `{ok,id,title,url}`；新增可选字段 `due_time`、`est_minutes`、`steps` |
| `POST /api/ai-parse` / `ai-batch` | 需要网页登录，给本站页面用 |
| `GET /uploads/<文件>` | 需要网页登录，支持 Range |
| `GET /health` | 健康检查 |

给 AI 的用法见 [SKILL.md](SKILL.md)。新界面自己用的接口在 `/app-api/*`（只认网页登录，不接受令牌），不属于对外接口，可能随版本变化。

## 设计约束（改界面先对这条）

- **一个主意**：打开首页先看到“今天还剩几项”，最大的元素就是这个数字。
- **配色**：冷灰底 + 白卡片；钢笔蓝（浅色 `#2B50E0`、深色 `#5B7CFF`）只用于按钮、选中和已完成；荧光黄 `#FFD84A` **只标最急的那一项**和剩余数量。科目不用颜色区分，用一个字的字块。除了这三种色只用灰阶。
- **字体**：中文用系统字体（苹方 / 微软雅黑），不引外部中文字体；数字（倒计时、日期、统计）用本地打包的 Space Grotesk。
- **浅色 / 深色**：默认跟随系统，“我的”里可以手动选，选择存在这台设备的 localStorage。深色底 `#0E1220`，不用纯黑。
- **布局**：手机单栏 + 底部四个标签（今天、日历、科目、我的），右下角“+”记作业，作业详情从右侧盖上来。宽度 ≥ 768px 时变成左侧导航 + 列表 + 详情三栏，选中项用蓝色竖线标出。
- **状态要齐**：键盘焦点可见；提交中按钮禁用并显示“正在保存…”；断网时显示“没有网络，显示的是 HH:MM 保存的数据”；空列表有说明文字；保存按钮写明为什么还不能保存。
- **动效**：只做 150ms 以内的过渡，尊重“减少动态效果”。不做撒花、弹跳。
- **触屏**：可点区域至少 44px 高，输入框字号 16px（避免 iOS 自动放大）。
- **需要 JavaScript**：这一版是 PWA，不再提供无 JS 的表单回退。

## 目录

```
server/        服务端（Hono + node:sqlite + web-push）
  legacy-api.ts  对外接口，与旧版保持一致
  app-api.ts     新界面用的接口
  push.ts        截止 / 每日 / 专注结束提醒
shared/        前后端共用的日期规则
web/           前端（Preact + Vite + Service Worker）
tests/         接口兼容、权限、旧库升级、提醒规则的测试
scripts/       导入工具
```

## 测试

```bash
npm test          # node:test，每个用例一个临时数据目录，不碰真实数据
npm run typecheck
```
