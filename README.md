# OpenClaw Bitrix24

**English** | [Русский](README.ru.md)

<!-- badges -->
<!-- [![npm](https://img.shields.io/npm/v/@openclaw/bitrix24)](https://www.npmjs.com/package/@openclaw/bitrix24) -->
<!-- [![CI](https://github.com/MissiaL/openclaw-bitrix24/actions/workflows/ci.yml/badge.svg)](https://github.com/MissiaL/openclaw-bitrix24/actions) -->
<!-- [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) -->

Channel plugin that connects your OpenClaw AI agent to Bitrix24: users chat with the agent through Bitrix24 Messenger. Pair it with any Bitrix24 REST skill if you want the agent to manage CRM, tasks, calendar, and drive on the portal.

## Features

All of these are verified against a live Bitrix24 portal:

- **Two-way messaging** in private and group chats, with Markdown ⇄ BB-code conversion and automatic chunking of long replies.
- **Inbound files** — user attachments (including cloud Drive files) are downloaded and handed to the agent as real media, with the original filename and MIME type recovered from the download response headers.
- **Outbound files** — the agent can generate a file and send it to the chat (uploaded via `imbot.v2.File.upload`, with an optional caption).
- **Quoted replies** — when a user quotes a message, the quoted content is resolved from an in-channel cache into the agent's context (Bitrix sends only the quoted message id).
- **Group chats** — the bot answers when mentioned (`@BotName`); Bitrix itself delivers group messages to a chatbot only on mention, so the agent never spams the room. A welcome message is sent when the bot joins.
- **Typing indicator** for the whole duration of an agent turn (refreshed every 8s), cleared right after the reply lands.
- **Control commands** — `/status`, `/new`, `/stop`, `/restart` with a native slash-command menu in the chat UI, gated by a `commandUsers` allowlist.
- **Message-tool targets** — the agent's `message` tool can send to `2172` (user) or `chat15762` (group chat) targets directly.

The plugin talks to Bitrix24's current chatbot API, **imbot.v2 (Chatbots 2.0)**, not the deprecated v1 `imbot.*` methods. All events (new message, command, join chat, bot deleted, ...) arrive on a **single webhook endpoint** per account, `/webhook/bitrix24/<accountId>`, dispatched internally by the event's `event` field (e.g. `ONIMBOTV2MESSAGEADD`). Bitrix24 manages the underlying event subscriptions automatically whenever the bot is registered or updated -- there is no manual `event.bind`/`event.unbind` step.

## Requirements

- **openclaw >= 2026.4** to use the modern webhook route (`api.registerHttpRoute`, mounted under `/webhook/bitrix24/` with plugin auth -- Bitrix24 cannot send a gateway token, so this route opts out of gateway *transport* auth; see [Security](#security) for the application-level protection the plugin adds on top).
- On older hosts, the plugin falls back to the legacy `registerService.router` mount, which is equally unauthenticated at the gateway level -- `auth: 'plugin'` is an opt-out of gateway auth, not an added protection by itself, so neither path is more secure than the other at the transport layer.

## Quick Start

### 1. Install the plugin

Clone this repo and install the built plugin:

```bash
git clone https://github.com/MissiaL/openclaw-bitrix24.git
cd openclaw-bitrix24/extensions/bitrix24
npm install && npm run build
openclaw plugins install .
```

> The `@openclaw/bitrix24` npm package is not published yet; once it is, `openclaw plugins install @openclaw/bitrix24` will be the one-line option. See [Installing from a working copy](#installing-from-a-working-copy) for the dev (no-build) alternative.

### 2. Get a webhook URL

In your Bitrix24 portal: **Developer resources > Other > Inbound webhook**.
Enable scopes: `imbot`, `im`, `disk`.
Copy the webhook URL (looks like `https://your-portal.bitrix24.ru/rest/1/abc123def/`).

### 3. Set the environment variable

```bash
export BITRIX24_WEBHOOK_URL="https://your-portal.bitrix24.ru/rest/1/abc123def/"
```

### 4. Start the agent

```bash
openclaw start
```

The plugin registers a chatbot in your Bitrix24 portal automatically on startup. Open Messenger, find the bot ("OpenClaw Agent"), and start chatting.

### 5. Verify

Run `/b24status` inside OpenClaw to check the connection:

```
/b24status
# Bitrix24 Accounts:
# - default (your-portal.bitrix24.ru): connected
```

## Configuration

The plugin supports two auth methods: webhook URL (simple) and OAuth (multi-portal).

### Option A: Webhook URL (quick setup)

Set `BITRIX24_WEBHOOK_URL` env var -- no config file changes needed.

Or add it to your `openclaw.yaml`:

```yaml
channels:
  bitrix24:
    webhookUrl: "https://your-portal.bitrix24.ru/rest/1/abc123def/"
```

### Public URL (event handlers)

Bitrix24 calls back into your bot over HTTP (the single `webhookUrl` passed to `imbot.v2.Bot.register`/`imbot.v2.Bot.update`), so the plugin needs to know the externally reachable base URL of your gateway. It resolves this in order:

1. `channels.bitrix24.publicUrl` (config)
2. `BITRIX24_PUBLIC_URL` environment variable
3. `gateway.externalUrl` (legacy, removed from the config schema in openclaw 2026.6 -- kept as a fallback for older hosts)
4. `http://localhost:18789` (local default)

Set it with:

```bash
openclaw config set channels.bitrix24.publicUrl https://bot.example.com
```

If `publicUrl` changes after the bot is already registered, the plugin detects the change on the next startup and calls `imbot.v2.Bot.update` with the new `webhookUrl` -- Bitrix24 re-points all of the bot's internal `ONIMBOTV2*` event subscriptions to the new base automatically, no manual re-registration needed. The last base registered per account is tracked internally under `channels.bitrix24.registeredWebhookBase.<accountId>`; this key is managed by the plugin and should not be edited by hand.

Bitrix24 v2 also supports a `fetch` (polling) event mode as an alternative to `webhook` mode (the bot polls `imbot.v2.Event.get` instead of receiving pushes). This plugin always registers in `webhook` mode; `fetch` mode is a possible future option if a deployment cannot expose a public URL at all.

### Security

The `/webhook/bitrix24/...` endpoint is publicly reachable at the gateway level: it is registered with `auth: 'plugin'` (and the legacy `registerService.router` fallback follows the same rule), both of which skip *gateway* token auth, because Bitrix24 has no way to send one.

The plugin closes that gap itself with **trust-on-first-use (TOFU) event authentication**. Every inbound event carries a top-level `auth.application_token` issued by the portal. On the first real event received for an account, the plugin captures and durably persists that token (`channels.bitrix24.accounts[].applicationToken`, plugin-managed). From then on, every incoming event for that account is checked against the pinned token; anything that doesn't match -- or omits the token once one is pinned -- is rejected with HTTP 403 and dropped before it reaches the agent.

This protects against forged event injection: once a token is pinned, an attacker who merely knows (or guesses) your `publicUrl` cannot get fabricated events accepted, because they cannot produce the portal's `application_token`.

**Caveat:** TOFU only protects *after* the first real event is trusted. If an attacker races the real portal and POSTs a forged first event before your actual Bitrix24 portal ever calls the webhook, the plugin will pin the attacker's token and reject the real portal's subsequent events instead. Mitigate this by connecting the portal (i.e. letting the real first event arrive) on a trusted network before the endpoint is exposed more broadly -- e.g. register the bot and exchange one message from the intended portal immediately after startup, before publishing `publicUrl` elsewhere.

Beyond TOFU, still treat inbound message content as untrusted input, and keep `publicUrl` reasonably non-guessable (a reverse-proxy path or a firewall allow-list for Bitrix24's IP ranges) as defense in depth.

### Option B: Multi-account / OAuth

```yaml
channels:
  bitrix24:
    accounts:
      - id: main
        webhookUrl: "https://portal-a.bitrix24.ru/rest/1/secret1/"
        bot:
          name: "Sales Bot"
          color: AZURE
          workPosition: "Sales Assistant"
          # bot.clientId is auto-derived from the webhook secret

      - id: support
        domain: portal-b.bitrix24.ru
        accessToken: "your-oauth-access-token"
        refreshToken: "your-oauth-refresh-token"
        clientId: "app.xxxxxxxx.xxxxxxxx"      # OAuth app clientId
        clientSecret: "your-client-secret"     # OAuth app clientSecret
        bot:
          name: "Support Bot"
          color: GREEN
          clientId: "stable-secret-bot-client-id"
        dmPolicy: paired          # "open" (default) or "paired"
        textChunkLimit: 3000      # max chars per message chunk (default: 18000)
```

### Config Reference

| Field | Type | Default | Description |
|---|---|---|---|
| `publicUrl` | string | see resolution chain above | Externally reachable base URL used for Bitrix24 event handlers |
| `registeredWebhookBase.<accountId>` | string | auto | Internal -- last `publicUrl` registered per account. Managed by the plugin; do not edit. |
| `webhookUrl` | string | -- | Bitrix24 inbound webhook URL |
| `accounts[].id` | string | `"default"` | Unique account identifier |
| `accounts[].domain` | string | auto | Portal domain (extracted from webhook URL) |
| `accounts[].webhookUrl` | string | -- | Per-account webhook URL |
| `accounts[].accessToken` | string | -- | OAuth access token |
| `accounts[].refreshToken` | string | -- | OAuth refresh token |
| `accounts[].clientId` | string | -- | OAuth app clientId used for token refresh |
| `accounts[].clientSecret` | string | -- | OAuth app clientSecret used for token refresh |
| `accounts[].enabled` | boolean | `true` | Enable/disable account |
| `accounts[].textChunkLimit` | number | `18000` | Max characters per message |
| `accounts[].dmPolicy` | string | `"open"` | `"open"` or `"paired"` |
| `accounts[].commandUsers` | string[] | `[]` | Bitrix user ids allowed to run control commands (`/status`, `/new`, `/stop`, `/restart`); `"*"` allows everyone; empty disables commands. Channel-level `commandUsers` acts as the default. |
| `accounts[].bot.name` | string | `"OpenClaw Agent"` | Bot display name |
| `accounts[].bot.lastName` | string | -- | Bot last name |
| `accounts[].bot.color` | string | `"PURPLE"` | Bot color in chat list |
| `accounts[].bot.workPosition` | string | `"AI Assistant"` | Shown under bot name |
| `accounts[].bot.avatar` | string | -- | Base64-encoded avatar image |
| `accounts[].bot.clientId` | string | auto for webhooks | Secret bot token (imbot.v2's `botToken` param) reused in every `imbot.v2.*` call |
| `accounts[].applicationToken` | string | auto (TOFU) | Internal -- pinned portal `application_token` used to authenticate inbound events. Managed by the plugin; do not edit. |
| `accounts[].botId` | number | auto | Pre-registered bot ID (skip registration) |
| `accounts[].botCode` | string | auto | Pre-registered bot code |

**Auth resolution order** (for the default account):
1. Per-account `webhookUrl` or `accessToken`
2. Global `channels.bitrix24.webhookUrl`
3. `BITRIX24_WEBHOOK_URL` environment variable

Non-default accounts only use per-account credentials.

## Bot token (`botToken`)

Bitrix24 imbot.v2 `imbot.v2.*` methods require a stable secret `botToken` tied to the bot creator (this value plays the same role v1 called `CLIENT_ID`, and the config field is still named `bot.clientId` for backward compatibility).

- webhook accounts derive it automatically from `md5(normalized webhookUrl)`
- OAuth accounts should set `accounts[].bot.clientId` explicitly
- the same value is sent as `botToken` on `imbot.v2.Bot.register`, `imbot.v2.Bot.update`, `imbot.v2.Bot.unregister`, `imbot.v2.Chat.Message.send`, `imbot.v2.Chat.Message.update`, `imbot.v2.Chat.Message.delete`, `imbot.v2.Chat.InputAction.notify`, `imbot.v2.File.upload`, and `imbot.v2.File.download`

Do not expose this value publicly. It is part of the bot control boundary.

## Chat commands

The plugin registers a native slash-command menu on the portal (idempotently, on every account startup) via `imbot.v2.Command.register`:

| Command | Action |
|---|---|
| `/status` | Agent status and subscription limits |
| `/new` | Start a new session |
| `/stop` | Stop the current run |
| `/restart` | Restart the OpenClaw gateway |

These are OpenClaw built-ins — the channel only decides *who* may run them, via `commandUsers`:

```yaml
channels:
  bitrix24:
    accounts:
      - id: default
        commandUsers: ["2172"]   # Bitrix user ids; "*" = everyone
```

By default (`commandUsers` empty) commands are **disabled**: the bot is reachable by every portal employee, and an open `/restart` would be a footgun. For unauthorized users a `/command` message is treated as plain text for the agent.

Menu invocations arrive as `ONIMBOTV2COMMANDADD` events; a manually typed `/command` may additionally fire a regular message event — the webhook router deduplicates by message id, so the agent sees each message exactly once.

## Architecture

```
+-------------------+         +---------------------------+
|   Bitrix24        |         |   OpenClaw Agent          |
|   Messenger       |         |                           |
|                   |         |  +---------+  +---------+ |
|  User writes msg  | ------> |  | Webhook |->| Agent   | |
|                   |  POST   |  | Server  |  | (LLM)   | |
|                   |         |  +---------+  +----+----+ |
|  Bot replies      | <------ |                    |      |
|                   | imbot.v2|  +---------+       |      |
|                   | .Chat.  |  | Bitrix24|<------+      |
|                   | Message.|  | Client  |  REST API    |
|                   | send    |  +---------+  (skill)     |
+-------------------+         +---------------------------+
```

**Message flow:**

1. User sends a message to the bot in Bitrix24 Messenger
2. Bitrix24 fires an `ONIMBOTV2MESSAGEADD` event to the single webhook endpoint (`/webhook/bitrix24/<accountId>`), authenticated via TOFU `application_token` matching
3. Webhook server parses the event, converts BB-code to Markdown; file attachments (`params.FILE_ID`) are downloaded and staged as local media for the agent; a quoted message (`params.REPLY_ID`) is resolved from the recent-message cache into the agent's reply context
4. Message is forwarded to the OpenClaw agent; a typing indicator (`imbot.v2.Chat.InputAction.notify`) is kept alive for the whole turn
5. Agent generates a response (optionally calling Bitrix24 REST API via skill)
6. Response is converted from Markdown to BB-code, chunked if needed
7. Bot replies via `imbot.v2.Chat.Message.send`; agent-generated files go via the single-call `imbot.v2.File.upload`

## File Structure

```
openclaw-bitrix24/
  extensions/bitrix24/           # OpenClaw channel plugin (npm package)
    openclaw.plugin.json         #   Plugin manifest
    package.json                 #   @openclaw/bitrix24
    src/
      index.ts                   #   Plugin entry point (channel + outbound adapters, HTTP route, commands)
      channel.ts                 #   Bitrix24Channel class (messaging, lifecycle, quote cache, command menu)
      inbound-dispatch.ts        #   Deliver parsed inbound events to the agent (runtime.channel.inbound.run): media staging, quotes, typing, command auth
      outbound-media.ts          #   Resolve the host's outbound mediaUrl (local path / file:// / http) into an upload
      persist.ts                 #   Durable config writes (runtime.config.mutateConfigFile, non-restarting)
      runtime.ts                 #   Runtime DI (logger, config, mutateConfigFile)
      public-url.ts              #   Resolve externally reachable base URL for event handlers
      setup-guide.ts             #   /b24setup instructions + welcome message
  src/bitrix24/                  # Core library
    accounts.ts                  #   Multi-account manager
    bot.ts                       #   Bot registration / unregistration / webhook URL updates (imbot.v2.Bot.register/update/unregister)
    client.ts                    #   Bitrix24 REST API client with rate limiter (retries on 503/429 + rate-limit error codes)
    commands.ts                  #   Slash-command menu registration (imbot.v2.Command.register/list)
    files.ts                     #   File send/receive via imbot.v2.File.upload/download (filename/MIME from response headers)
    format.ts                    #   Markdown <-> BB-code conversion
    receive.ts                   #   Parse incoming imbot.v2 webhook events (messages, commands, files, quotes); TOFU verification
    send.ts                      #   Send messages (chunking, typing, media) via imbot.v2.Chat.*
    targets.ts                   #   DIALOG_ID parsing (user vs. chat)
    token.ts                     #   Auth resolution (webhook URL / OAuth / env)
    types.ts                     #   TypeScript interfaces
    webhook-server.ts            #   Single-endpoint Express router for all imbot.v2 events (message-id dedup)
  tests/unit/                    # Unit tests
    format.test.ts               #   Markdown/BB-code conversion tests
    receive.test.ts              #   Event parsing tests
    targets.test.ts              #   DIALOG_ID parsing tests
    token.test.ts                #   Auth resolution tests
```

## Development

### Prerequisites

- Node.js >= 20 (required by the published `@openclaw/bitrix24` package; see `engines` in `extensions/bitrix24/package.json`)
- npm

### Setup

```bash
git clone https://github.com/MissiaL/openclaw-bitrix24.git
cd openclaw-bitrix24
npm install
```

### Installing from a working copy

Two ways to run the plugin from this repo without publishing to npm:

- **Dev (TypeScript sources loaded directly):** add the plugin directory to `plugins.load.paths` in your OpenClaw config, e.g.:

  ```yaml
  plugins:
    load:
      paths:
        - /path/to/openclaw-bitrix24/extensions/bitrix24
  ```

  OpenClaw resolves the entry point from `openclaw.extensions` in `extensions/bitrix24/package.json` (`./src/index.ts`) and runs the TypeScript source directly -- no build step needed. Requires openclaw >= 2026.4 for the modern webhook route (see below); on older hosts the legacy router still works.

- **Prod (compiled build, installed like a published package):**

  ```bash
  cd extensions/bitrix24
  npm install
  npm run build
  openclaw plugins install .
  ```

  This builds `dist/` and installs the plugin from the compiled entry declared in `openclaw.runtimeExtensions` (`./dist/extensions/bitrix24/src/index.js`).

### Build

```bash
npm run build
```

### Test

```bash
npm test              # run once
npm run test:watch    # watch mode
```

### Lint

```bash
npm run lint
```

## Scopes

The Bitrix24 webhook or OAuth app needs these scopes:

| Scope | Required | Used for |
|---|---|---|
| `imbot` | Yes | Register/unregister chatbot, send messages as bot |
| `im` | Yes | Send messages, manage chats, commit files to chats |
| `disk` | Yes | Upload/download files, storage access |
| `crm` | For skill | CRM operations (deals, contacts, leads, companies) |
| `task` | For skill | Task management |
| `calendar` | For skill | Calendar events |
| `user` | For skill | User search, department info |
| `department` | For skill | Department management |

**Minimum for channel only:** `imbot`, `im`, `disk`.
**Recommended for full functionality:** all of the above.

## Troubleshooting

### Bot does not appear in Messenger

- Verify `BITRIX24_WEBHOOK_URL` is set and points to a valid webhook.
- Ensure the webhook has the `imbot` scope enabled.
- Run `/b24status` -- if it shows "connected", the bot should appear in the contact list under "Bots and apps".
- Check the OpenClaw agent logs for registration errors.

### Messages are not received

- The agent must be reachable from the internet. Bitrix24 posts every `ONIMBOTV2*` event, including new messages, to the single webhook endpoint `{publicUrl}/webhook/bitrix24/{accountId}`.
- Check that `channels.bitrix24.publicUrl` (or `BITRIX24_PUBLIC_URL`) resolves to a publicly accessible HTTPS URL. See [Public URL (event handlers)](#public-url-event-handlers).
- Verify the webhook URL in Bitrix24 is not expired or revoked.
- If the account was previously connected from a different `publicUrl` and the first event since then didn't come from the real portal, TOFU may have pinned the wrong `application_token` and be rejecting real events with HTTP 403 -- see [Security](#security). Clear `accounts[].applicationToken` for the account and let the next real event re-pin it.
- To trace inbound delivery, set `BITRIX24_DEBUG=1` in the gateway environment. This logs the raw event body, the parsed message, the dispatch to the agent, and the reply delivery back to the dialog. It includes user message content (PII), so enable it only for a debugging session and unset it afterwards. Structural diagnostics (event name, account, field lengths, which host helpers resolved) are always logged regardless of the flag.

### Rate limit errors (`QUERY_LIMIT_EXCEEDED` / HTTP 503 / HTTP 429)

Bitrix24's own docs disagree on the exact signal (`limits.md`/`error-codes.md` say HTTP 503 + `QUERY_LIMIT_EXCEEDED`; the imbot.v2 limits table says HTTP 429), so the client retries with exponential backoff on either, plus `OVERLOAD_LIMIT`/`OPERATION_TIME_LIMIT`. The client also enforces a 2 req/s token-bucket rate limiter by default. If you still hit limits, reduce the `rateLimit` config or avoid parallel requests to the same portal.

### Long messages are truncated

Bitrix24 has a message length limit. The plugin automatically splits messages at paragraph/sentence boundaries. Adjust `textChunkLimit` (default 18000) if chunks are still too large.

### File upload fails

- Ensure the `disk` scope is enabled on the webhook (still required by imbot.v2 even though `imbot.v2.File.upload` is a single call that no longer requires managing Disk storage/folders yourself).
- Files over 100 MB fail with `FILE_TOO_LARGE`.
- **Inbound files (received from a user):** live-verified — an attachment arrives as `message.params.FILE_ID: ["<driveFileId>"]` (no name/size; the real filename and MIME type come from the download response headers). The doc-suggested `params.files` shapes are kept as fallbacks. If an attachment isn't detected, run with `BITRIX24_DEBUG=1` and file an issue with a redacted raw event payload.

### Bot replies with garbled formatting

The plugin converts Markdown to BB-code (Bitrix24's native format). If you see raw BB-code tags, the conversion may have a bug -- file an issue with the input text.

### OAuth token expired

For OAuth accounts, provide both `accessToken` and `refreshToken`. The client supports token refresh, but auto-refresh requires `clientId` and `clientSecret` to be configured.

## License

MIT
