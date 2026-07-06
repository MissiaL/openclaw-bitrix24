# @openclaw/bitrix24

> **⚠️ Тестовая сборка (beta).** Этот плагин находится в стадии активной разработки. Если у вас есть вопросы или предложения — пишите на [bitrix@me.com](mailto:bitrix@me.com).

Bitrix24 channel plugin for [OpenClaw](https://github.com/openclaw/openclaw) — chat with your AI agent through Bitrix24 Messenger.

Uses Bitrix24's current chatbot API, **imbot.v2 (Chatbots 2.0)**, not the deprecated v1 `imbot.*` methods. All events arrive on a single webhook endpoint per account (`/webhook/bitrix24/<accountId>`), dispatched by the event's `event` field; Bitrix24 manages the underlying event subscriptions automatically.

## Requirements

- openclaw >= 2026.4 to use the modern webhook route (`api.registerHttpRoute`, plugin-authenticated). Older hosts fall back to the legacy `registerService.router` mount automatically.
- Node.js >= 20 (published package `engines`).

## Install

```bash
openclaw plugins install @openclaw/bitrix24
```

### Installing from source

- **Dev** — add this directory to `plugins.load.paths` in your OpenClaw config; the TypeScript entry (`src/index.ts`) is loaded directly, no build step needed.
- **Prod** — build and install the compiled package:

  ```bash
  cd extensions/bitrix24
  npm install
  npm run build
  openclaw plugins install .
  ```

## Quick Setup

1. Create an inbound webhook in your Bitrix24 portal: **Developer resources → Other → Inbound webhook**
2. Enable scopes: `imbot`, `im`, `disk`
3. Set the webhook URL:

```bash
export BITRIX24_WEBHOOK_URL="https://your-portal.bitrix24.ru/rest/1/your-secret/"
```

4. Start the agent:

```bash
openclaw start
```

The bot appears in Bitrix24 Messenger automatically.

## Public URL

The plugin needs your gateway's externally reachable base URL for Bitrix24's event callbacks — v2 uses a single `webhookUrl` (passed to `imbot.v2.Bot.register`/`imbot.v2.Bot.update`) that covers all `ONIMBOTV2*` events, unlike v1's separate `EVENT_MESSAGE_ADD`/`EVENT_WELCOME_MESSAGE`/`EVENT_BOT_DELETE` handler URLs. Resolution order:

1. `channels.bitrix24.publicUrl` (config) — set with `openclaw config set channels.bitrix24.publicUrl https://bot.example.com`
2. `BITRIX24_PUBLIC_URL` env var
3. `gateway.externalUrl` (legacy fallback, for older hosts)
4. `http://localhost:18789`

If `publicUrl` changes, the plugin calls `imbot.v2.Bot.update` on the next startup to re-point the bot's `webhookUrl` — Bitrix24 automatically re-syncs all `ONIMBOTV2*` event subscriptions to the new base, no manual re-registration needed. The last registered base is tracked per account under `channels.bitrix24.registeredWebhookBase.<accountId>`; this is an internal, plugin-managed key — don't edit it by hand.

Bitrix24 v2 also offers a `fetch` (polling) event mode as an alternative to `webhook` mode. This plugin always registers in `webhook` mode; `fetch` is a possible future option for deployments that can't expose a public URL.

### Security

The webhook endpoint is publicly reachable at the gateway level: `auth: 'plugin'` (and the legacy `registerService.router` fallback) both skip *gateway* token auth, since Bitrix24 has no way to send one.

The plugin protects itself with **trust-on-first-use (TOFU) event authentication**: it captures the portal's `application_token` from the first real event per account, persists it (`accounts[].applicationToken`), and rejects any subsequent event whose token doesn't match with HTTP 403. This stops forged event injection by anyone who merely knows the URL, since they cannot produce the portal's token.

**Caveat:** a forged first event delivered before the real portal ever connects would get pinned instead, causing the real portal's later events to be rejected. Connect the portal (let its first real event arrive) on a trusted network before publishing `publicUrl` more broadly.

Beyond TOFU, keep `publicUrl` non-guessable where possible (a reverse-proxy path or a firewall allow-list for Bitrix24's IPs), and still treat inbound message content as untrusted input.

## Multi-Account / OAuth

```yaml
channels:
  bitrix24:
    accounts:
      - id: main
        webhookUrl: "https://portal-a.bitrix24.ru/rest/1/secret1/"
        bot:
          name: "Sales Bot"
          color: AZURE
          # bot.clientId is auto-derived from the webhook

      - id: support
        domain: portal-b.bitrix24.ru
        accessToken: "your-oauth-access-token"
        refreshToken: "your-oauth-refresh-token"
        clientId: "app.xxxxxxxx.xxxxxxxx"       # OAuth app clientId
        clientSecret: "your-client-secret"      # OAuth app clientSecret
        bot:
          name: "Support Bot"
          clientId: "stable-secret-bot-client-id"
```

OAuth tokens are refreshed automatically when `clientId` and `clientSecret` are provided.

For `imbot.v2.*` calls, the plugin also needs a stable bot token (config field `bot.clientId`, sent as v2's `botToken` param):

- webhook accounts derive it automatically from the webhook secret
- OAuth accounts should set `bot.clientId` explicitly
- the same value is reused across all `imbot.v2.*` methods (`Bot.register`, `Bot.update`, `Bot.unregister`, `Chat.Message.*`, `Chat.InputAction.notify`, `File.upload`, `File.download`)

## Required Scopes

| Scope | Required | Used for |
|---|---|---|
| `imbot` | Yes | Bot registration, send messages as bot |
| `im` | Yes | Messaging, chat management |
| `disk` | Yes | File upload/download |

## Documentation

Full documentation, architecture, and troubleshooting: [github.com/rsvbitrix/openclaw-bitrix24](https://github.com/rsvbitrix/openclaw-bitrix24)

## Feedback

This is a beta release. Questions, bugs, feature requests — email [bitrix@me.com](mailto:bitrix@me.com).

## License

MIT
