# School Board AI Skill

This file tells an AI agent how to record school homework, notices, listening
audio, or study material into this board through its HTTP API. It contains no
base URL, no token, and no child names. The user supplies the base URL and the
token for each setup, and the agent must use them only for that setup.

## 1. Get the lists first

- `GET http://HOST/api/lists`, with header `X-API-Token: <token>` when a token
  is configured.
- The response returns `children` (`{"id": 0, "name": "全部"}` plus real children)
  and `subjects` (for example `["语文", "数学", "英语", ...]`).
- Use those exact values and nothing else. Child id `0` means shared, not
  assigned to one child.
- If the lists call returns 401, stop and ask the user for a valid token.
  Never guess a child id or a subject name.

## 2. Confirm before you create

- Turn the user's words or photo into draft items first, and show each draft
  with subject, kind, child, due date, and title.
- Create only the drafts the user confirms. Drop rejected drafts, and leave
  ambiguous drafts out instead of guessing a subject or a child.
- After creating, report the returned id and title for each item, and what
  was left out and why.

## 3. Create one item at a time

- `POST http://HOST/api/items`, with header `X-API-Token: <token>` when a
  token is configured.
- Text fields may be form fields or JSON. A file must be multipart form data
  in the `file` field. JSON cannot carry a binary file.
- `subject` must match a lists subject exactly, otherwise do not create the
  item. Ask the user to add the subject in the admin page first, or ask
  which listed subject to use.
- `child_id` must match a lists child id exactly, otherwise do not create
  the item for that child. Use `0` only when the user means shared.
- `kind` is one of `notice`, `homework`, `material`, `answer`, `listening`,
  `announcement`. Leave it out when unsure: audio files infer to listening,
  PDF files infer to material, everything else infers to notice.
- `due` is `YYYY-MM-DD` or empty. Convert relative dates such as tomorrow
  or next Friday to an absolute date before sending.
- `title` is optional. When omitted, the server falls back to the file name
  or the first line of the body.
- A successful create returns `{"ok": true, "id": ..., "title": ...}` with
  HTTP 201. If one create fails, report that item and stop until the user
  tells you how to proceed. Do not retry blindly.

## 4. What the token does not allow

- The token allows listing, reading visible items, and creating only. It does not allow deleting
  items, adding or renaming children, or adding or deleting subjects.
- Never call an admin page or admin action with the token. Those need the
  admin login, which only the user handles in the browser.
- Never use `/api/ai-parse` or `/api/ai-batch` from an external agent.
  Those are for the board's own register page on the local network only.

## 5. Public access (optional, template only)

When an AI outside the home network needs to reach the board, expose only
`/api/lists` and `/api/items` through the reverse proxy, and nothing else.
Configure an environment or admin-generated API token before exposing these paths;
`GET /api/items` requires the same token when one is configured. Without a token,
the API remains trusted-LAN only. The token is not authentication for the web UI.
Replace `BOARD` with the host prefix the user chooses, and
`BOARD_BACKEND` with the board's local address. This snippet is a template,
not a deployed configuration.

```
@boardapi expression `{http.request.host}.matches('^BOARD[.]')`
handle @boardapi {
  request_body {
    max_size 60MB
  }
  @api path /api/lists /api/items
  reverse_proxy @api http://BOARD_BACKEND:8765 {
    header_up Host {host}
    header_up X-Real-IP {remote_host}
    header_up X-Forwarded-Port {http.request.port}
  }
}
```

After applying a Caddy change, reload with:
`docker exec webserver caddy reload --config /etc/caddy/Caddyfile`
