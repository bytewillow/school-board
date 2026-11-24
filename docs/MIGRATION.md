# 从 1.x（app.py）升级到 2.0

## 数据库变化（只加不删）

| 位置 | 变化 |
| --- | --- |
| `items` | 新增 `due_time`（HH:MM，空表示按当天 21:00）、`est_minutes`、`remind`（空 / off / 60 / 120 / 180 / eve）、`done_at` |
| 新表 `steps` | 作业的分步骤 |
| 新表 `focus_sessions` | 每次专注的时长，用于“本周专注用时” |
| 新表 `prefs` | 每个孩子的提醒、专注设置 |
| 新表 `push_subs`、`push_queue`、`push_log` | 推送订阅、待发的专注结束提醒、已发记录（防止重复） |
| 新表 `meta` | 版本号、自动生成的 VAPID 密钥 |

旧表 `items`、`subjects`、`children`、`sessions`、`api_tokens` 一列都没删。第一次启动前自动复制 `board.db` 到 `board.db.v1-backup`（只复制一次）。

## 行为上的不同

- **截止时间**：旧数据只有日期，新版按当天 21:00 计算倒计时和提醒；界面上会写“没写时间，按 21:00 算”。
- **打卡统计**：旧数据没有完成时间，已完成的一律算按时。
- **JSON 提交**：`POST /api/items` 用 JSON 时，`false` / `null` 现在当空值。旧版会把它们变成字符串 `"False"` / `"None"`，导致 `"pinned": false` 被当成置顶。
- **附件找不到**：`/uploads/*` 找不到文件时返回 JSON 404，不再是 HTML 错误页。
- **跨站请求被拒**：返回 JSON 403，不再是 HTML 错误页。
- **旧网页路由**：`/item?id=`、`/register`、`/admin`、`/login` 仍能打开，由新界面接管；旧的表单提交地址（`POST /add`、`/done`、`/item/edit`、`/admin/*` 等）已经移除，新界面改用 `/app-api/*`。它们只给旧网页自己用，不属于对外接口。
- **离线**：旧版刻意不缓存作业数据。新版会把最近一次的作业列表存在这台设备上，断网时显示并标明“保存的数据”；退出登录时清掉。

## 回滚

1. 停掉新版。
2. 需要完全回到升级前：用 `board.db.v1-backup` 覆盖 `board.db`（会丢掉升级后的改动）；只想换回旧程序：直接用旧镜像启动同一个 `data/`，旧版会忽略新增的列和表。
3. 删除 `board.db-wal`、`board.db-shm` 前先确认新版已经完全停止。

## 导入

```bash
npm run import -- --from /另一份/data
npm run import -- --url http://旧服务器:8765 --token sb_xxx [--cookie "sb_session=..."]
```

- `--from`：读另一份 `board.db` 和 `uploads/`。孩子按名字合并（目标没设密码时沿用来源的密码），学科按名字合并，条目追加并改到对应孩子，附件按文件名复制。不导入会话和令牌。
- `--url`：只能拿到 API 公开的字段。拿不到定时显示时间、置顶、原创建时间；还没到显示时间的条目 API 不返回，也就导不进来。附件要带家长登录的 cookie 才能下载。
- 两种方式都按“标题 + 学科 + 孩子 + 附件”等字段识别重复，重复导入会跳过。
