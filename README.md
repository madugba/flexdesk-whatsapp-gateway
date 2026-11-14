# FlexDesk WhatsApp Gateway

A small, single-purpose service that keeps WhatsApp connections open for many FlexDesk
institutions and exposes them over a REST API and signed webhooks. FlexDesk (Next.js on
Hostinger) cannot hold long-lived connections, so this service does it.

```
Parent ── WhatsApp ── Gateway (Render) ── signed webhook ──▶ FlexDesk
                          ▲                                      │
                          └───────── REST: send a reply ◀────────┘
```

- **One connection per school**, linked by scanning a QR code (a linked device, like WhatsApp Web).
- **Encrypted at rest.** Credentials and Signal keys live in Postgres, AES-256-GCM, each value bound to its row.
- **Exactly one process holds connections** (Postgres advisory lock), so Render's overlapping deploys never run two connections for one number.
- **Reliable events.** Webhooks go through a Postgres outbox with retries and backoff for about eight hours.
- **Built to avoid bans.** Replies only, to people who messaged first; spaced, typed, rate-capped sends.

> **Unofficial.** This uses WhatsApp Web's protocol through [Baileys](https://github.com/WhiskeySockets/Baileys),
> not Meta's Business API. WhatsApp's terms do not allow unofficial clients and numbers can be banned.
> Use a dedicated number per school, never a personal one, and tell schools the risk.

## Safety rules the gateway enforces

| Rule | Why |
| --- | --- |
| Reply window: only people who messaged the school in the last `REPLY_WINDOW_HOURS` (24) can be messaged | Never cold-messages, the pattern WhatsApp bans for |
| Sends are serialized per session with jittered spacing, a typing indicator, a queue cap and an hourly cap | Looks like a person, not a script |
| Groups, broadcasts, channels and status are ignored | Out of scope; avoids noise and risk |
| `MAX_SESSIONS` cap | Keeps memory inside the host's limit |
| Never reconnects after `logged_out` or `replaced` | Avoids fighting WhatsApp or another device |

## Configuration

Copy `.env.example`. Required: `DATABASE_URL`, `GATEWAY_API_KEYS`, `GATEWAY_ENCRYPTION_KEY`,
`WEBHOOK_URL`, `WEBHOOK_SECRET`.

```bash
openssl rand -hex 32      # GATEWAY_API_KEYS / WEBHOOK_SECRET
openssl rand -base64 32   # GATEWAY_ENCRYPTION_KEY
```

- `GATEWAY_ENCRYPTION_KEY` cannot be rotated in place: losing or changing it makes every stored session unreadable and every school must re-scan. Back it up in a password manager.
- `GATEWAY_API_KEYS` accepts two comma-separated keys so you can rotate with no downtime: add the new key, update FlexDesk, remove the old key.

## Database (Supabase)

The gateway needs its own schema and a role that owns only that schema. In the Supabase SQL editor:

```sql
create role wa_gateway_app login password '<generate a strong password>';
create schema wa_gateway authorization wa_gateway_app;
revoke all on schema wa_gateway from public;
```

Use the **session pooler** connection string (port 5432), not the transaction pooler (6543): the
leader lock is a session-level advisory lock. The string looks like
`postgresql://wa_gateway_app.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`.
Set `DB_SSL_CA` to Supabase's CA certificate (Project Settings > Database > SSL) to verify the server; without it the
connection is encrypted but the server's identity is not checked.

Tables are created automatically on start (`migrations` are idempotent and run under an advisory lock).
Row-level security is enabled on every table with no policies, so Supabase's API roles cannot read them.

## Deploy on Render

1. Push this repo to GitHub, then **New > Blueprint** and select it. `render.yaml` defines the service.
2. Fill the secrets Render asks for. Set `WEBHOOK_URL` to FlexDesk's `/api/webhooks/whatsapp-gateway`.
3. Check `https://<service>.onrender.com/healthz` returns `{"status":"ok"}`.
4. Keep it awake: Render's free plan sleeps a service after 15 minutes without inbound traffic, which
   would drop every WhatsApp connection. Ping `/healthz` **every 10 minutes** (a Hostinger cron job or an uptime monitor).

The free plan can also restart the service at any time, and its 512 MB of memory limits you to a handful of
sessions. Treat it as a test environment; for real schools move to a paid instance (no code changes).
Idle memory is about 130 MB, plus a small amount per connected school.

## API

All `/v1` routes need `Authorization: Bearer <GATEWAY_API_KEY>` and return `Cache-Control: no-store`.
Errors are `{ "error": { "code": "...", "message": "..." } }`.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/sessions` `{ "sessionId" }` | Create or resume a session; returns its state. Idempotent. |
| `GET` | `/v1/sessions/:id` | State, including the `qr` string while `status` is `qr`. |
| `GET` | `/v1/sessions` | All sessions (never includes QR codes). |
| `POST` | `/v1/sessions/:id/reconnect` | New connection and fresh QR after `qr_expired`, `replaced`, `error` or `logged_out`. |
| `DELETE` | `/v1/sessions/:id` | Unlink the device and delete everything stored. |
| `POST` | `/v1/sessions/:id/messages` | `{ "to", "text", "idempotencyKey"? }`. `to` is a chat id from a webhook (preferred) or a phone number in international digits. |
| `GET` | `/v1/status` | Leader state, session count, outbox backlog, memory. |
| `GET` | `/healthz` | Public liveness check. |

Session ids are 8 to 64 characters of letters, digits, `_` and `-`. Statuses:
`connecting`, `qr`, `open`, `reconnecting`, `logged_out`, `replaced`, `qr_expired`, `error`.

**The QR string is a credential**: anyone holding it while it is valid can link the account. FlexDesk must show it
only to the institution's own admin, render it client-side, and never log or store it.

Always reply to the `chatId` from the webhook. WhatsApp may identify a person by an opaque id instead of a phone
number, in which case `phone` is `null` and only `chatId` works.

Send errors: `session_not_open` (409), `outside_reply_window` (422), `invalid_recipient` (422), `queue_full` and
`rate_limited` (429, with `Retry-After`), `duplicate_in_flight` (409), `send_failed` (502). Retrying with the same
`idempotencyKey` never sends twice.

## Webhooks

`POST` to `WEBHOOK_URL`, JSON, any non-2xx is retried with backoff (about eight hours) and the receiver must
deduplicate by `id`.

```json
{ "id": "123", "type": "message.received", "sessionId": "...", "occurredAt": "2026-11-14T10:00:00.000Z",
  "data": { "messageId": "...", "chatId": "2348012345678@s.whatsapp.net", "phone": "2348012345678",
            "pushName": "Ada", "timestamp": 1794650000, "type": "text", "text": "How much are fees?" } }
```

Types: `message.received` (`type` is `text` or `unsupported`) and `session.status`
(`data: { status, phone, reason }`, sent for `open`, `reconnecting`, `logged_out`, `replaced`, `qr_expired`, `error`).

Verify every request: header `X-Gateway-Signature: t=<unix seconds>,v1=<hex>` where `v1` is
`HMAC-SHA256(WEBHOOK_SECRET, "<t>.<raw body>")`. Reject if it does not match or `t` is more than 5 minutes old.
Reference implementation: `src/webhooks/signature.ts`.

## Operations

- **Logs** are JSON. Phone numbers are masked, and message text, QR codes and credentials are never logged.
- **A school's number is banned or unlinked:** the session goes to `logged_out`, FlexDesk is notified, and the school links again from FlexDesk.
- **Stuck webhook events:** `GET /v1/status` shows `webhooks.failed`; parked events are in `webhook_outbox` (`failed_at` set).
- **Deploys:** the new instance answers health checks immediately and takes over connections as soon as the old one stops (a few seconds).
- **Upgrading Baileys:** WhatsApp changes its protocol; pin the version, upgrade on a branch and run the tests.

## Development

```bash
pnpm install
cp .env.example .env     # fill in; DATABASE_URL can be a local Postgres
pnpm dev
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/gateway_test pnpm test
```

Tests run against a real Postgres (each file in its own schema). WhatsApp itself cannot be reached in tests, so the
Baileys adapter is covered by a wiring test against a local WebSocket server and the rest by a fake engine.
