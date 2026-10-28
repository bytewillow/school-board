# 家长 / 学生登录与 HTTPS 部署说明

本次迁移只新增 `children.password_hash` 和 `sessions` 表，不迁移、删除或重新归属旧条目、孩子、学科、令牌。历史共享条目及共用完成状态保持不变。回滚代码可以忽略新增列和表，但回滚后旧版本的开放访问行为也会恢复，不能继续全站公网反代。

## 登录与会话

- 家长仍在 `/admin` 输入现有 `ADMIN_PASSWORD`。新登录创建 `sb_session` 会话；原先有效的 `admin` cookie 继续兼容，不再新发该旧 cookie。
- 家长在 `/admin/children` 每个孩子的密码区设置至少 6 位密码，只显示“已设密码 / 未设密码”，不会回显密码。修改、清除密码或删除孩子都会撤销该孩子所有学生会话。改名按原 id 保留密码。
- 学生在 `/login` 输入孩子名字和密码。公开登录表单不枚举孩子名单，所有认证失败统一提示“名字或密码不对”。
- 学生首页复用原活页夹，固定为自己，不展示其他孩子；登记页和内嵌 AI 列表也只有自己，不能切换归属。历史共享条目仍可看、可完成。
- 新密码为每次随机 16 字节 salt + PBKDF2-HMAC-SHA256（200000 次），保存 `salt_hex:hash_hex`；会话明文随机 token 只进 HttpOnly cookie，数据库仅存 SHA256。有效期 30 天；失效/过期会话当未登录处理。
- Cookie 为 `Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`。请求带 `X-Forwarded-Proto: https` 时加 `Secure`，直接 HTTP 不加。代理必须覆盖该转发头，不应让不可信代理注入。HTTP 登录的密码和 cookie 不受传输加密保护；正式远程使用应经 HTTPS。
- 学生用“退出登录”（`POST /logout`）；家长沿用“退出管理”（`POST /admin/logout`），均删除对应新会话并清除新旧 cookie。兼容旧 cookie 是规格要求：旧 cookie 本身没有服务端会话行，复制出去的旧 cookie 无法靠此次登出撤销；不要把它当作可撤销的新会话。

## 权限对账

| 路由 | 未登录 | 家长 | 学生 |
| --- | --- | --- | --- |
| `/`、`/register` | 303 `/login` | 原多孩行为 | 固定为会话孩子，忽略 URL 的其他孩子 |
| `POST /add`、`POST /admin/add` | 303 `/login` | 有效孩子才创建 | 只接受自己的 child_id，缺失/不同返回 400，不悄悄改归属 |
| `/item`、`/uploads/*`、`POST /done` | 303 `/login` | 原行为 | 仅自己或共享；他人一律 404；定时未公开内容不泄露 |
| `/admin`、管理子页和其余 `POST /admin/*` | 原登录页 / 303 `/admin` | 原行为 | 403 友好页 |
| `/login` GET/POST | 名字与密码表单 / 验证 | 303 `/admin` | 303 `/` |
| `POST /admin/child/password` | 303 `/admin` | 设置/更新/清除 | 403 |
| 三个 `/api/ai-*` | JSON 401 unauthorized | 原验证 | parse/voice 的其他孩子 JSON 400 invalid_child；batch 对不属于自己的草稿逐项 failed |
| `/api/lists`、`/api/items` | 现有令牌规则 | 不因会话绕过令牌 | 不因会话限制或绕过令牌 |
| `/api`、`/health`、静态资源、图标、manifest、sw.js | 公开 | 公开 | 公开 |

规格第 4 节的 `/admin/add` 专行允许学生登记，而同节“全部 POST /admin/*”写为学生无权限，二者有冲突。这里优先采用更具体的登记专行：仅 `POST /admin/add` 是管理前缀下的例外，执行与 `/add` 相同的 child_id 校验；学生成功后回自己本子，不进管理页。`GET /admin/add` 和其他管理操作仍为 403。

`/api/lists`、`/api/items` 保留现有环境令牌/数据库令牌和查询参数兼容规则：配置了令牌时无有效令牌一律 401；完全没配置令牌时仍保留旧的匿名局域网模式。准备全站公开前必须确认已配置有效 API 令牌，否则两个接口仍会开放读写。本 PR 不改变此行为。它们返回的网页/附件链接现在需网页登录，API 令牌本身不会授予附件访问权。

补充同源保护：显式跨站 Origin 的会话写入返回 403；同源使用正常。HTML、JSON、附件响应 `no-store`，服务 worker 不缓存动态内容。学生可上传文件不能获得站点脚本权限：HTML/SVG/XML 以附件下载，并加 CSP sandbox 与 nosniff。其他类型保留图片/PDF/音频查看和字节范围请求。

## 验证与上线（由 Luna 合并后另做）

1. Review 后合并，确认 tests 和 main 的 docker Actions 成功。PR 本身只运行 tests 工作流；原 docker 工作流只在 main/tag/手动触发，不在 PR 推送镜像。
2. 备份生产数据；在 pve4 拉取已构建镜像并验证应用。此 PR 不改生产 compose、不接触生产库。
3. 验证已配置 API 令牌。先备份 router102 的 Caddyfile，再将现有 `homework.mynas.stream` 段由仅 `/api/lists`、`/api/items` 扩大为全站反代到 `192.168.11.252:8765`，保留 `proxy_headers` 和 `request_body max_size 60MB`，再 reload。此 PR 不修改该文件或执行 reload。
4. 经 HTTPS 用独立未登录浏览器访问首页应到 `/login`；带/不带令牌分别验证两个令牌接口；家长登录、管理子页、设学生密码、学生登录、只见自己、403 管理页、404 他人条目、登出、改/清密码撤销旧学生会话。
5. 检查 HTTPS 的 Set-Cookie 含 Secure / HttpOnly；直接 HTTP 的新 cookie 无 Secure，但同样必须登录，不能局域网绕过。
6. 真机 Safari 经该 HTTPS 域名验证麦克风授权、录音、转写和 AI 草稿；再回归学生侧全部页面、附件全屏、PDF、音频、定时显示和触摸操作。

自动化仅使用隔离临时数据库、虚构名、测试专用凭据及本地模拟模型；没有生产孩子名、真实密码或令牌明文。没有在生产域名、真实手机/Safari或真实麦克风上验证。未加入找回密码、验证码、登录失败锁定、2FA；HTTPS 与登录不是这些防护的替代品。
