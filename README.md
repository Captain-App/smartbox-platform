# Smartbox Platform

> **Your AI companion in the cloud — always-on, never dies.**

The Smartbox Platform runs [OpenClaw](https://github.com/openclaw/openclaw) personal AI assistants in [Cloudflare Sandboxes](https://developers.cloudflare.com/sandbox/), giving you a team of specialized AI agents that are always available, with persistent memory, and accessible from anywhere.

![Smartbox Platform](./assets/logo.png)

## What is a Smartbox?

A **Smartbox** is your personal AI companion that lives in the cloud. Unlike your phone's voice assistant that wakes up when you ask, a Smartbox is **always-on** with **persistent memory** — it remembers your conversations, knows your preferences, and can work on tasks even when you're offline.

### Types of Smartboxes

| Type | Purpose | Example |
|------|---------|---------|
| **PA Smartbox** | Your personal assistant | Daily tasks, scheduling, Q&A |
| **Project Smartbox** | Specialized for a project | Code reviews, deployment, architecture |
| **Runtime Smartbox** | Infrastructure management | Server monitoring, debugging |
| **Custom Smartbox** | Any specialized need | Research, finance, creative |

Read the full [Vision](./VISION.md) to understand the Smartbox Platform concept.

---

## Quick Start

> **Note:** Cloudflare Sandboxes require the [Workers Paid plan](https://www.cloudflare.com/plans/developer-platform/) ($5 USD/month).

```bash
# Clone and install
git clone https://github.com/captainapp/smartbox-platform.git
cd smartbox-platform
npm install

# Set your AI provider API key
npx wrangler secret put ANTHROPIC_API_KEY
# OR use AI Gateway (see below)

# Generate a gateway token for secure access
export GATEWAY_TOKEN=$(openssl rand -base64 32 | tr -d '=+/' | head -c 32)
echo "Your gateway token: $GATEWAY_TOKEN"
echo "$GATEWAY_TOKEN" | npx wrangler secret put MOLTBOT_GATEWAY_MASTER_TOKEN

# Deploy
npm run deploy
```

After deploying, access your Smartbox Control UI:
```
https://your-worker.workers.dev/?token=YOUR_GATEWAY_TOKEN
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Your Smartbox Ecosystem                        │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                    Cloudflare Edge                            │  │
│  │                                                              │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │  │
│  │  │Edge Router  │  │  Admin API  │  │  Container Gateway  │  │  │
│  │  │             │  │             │  │                     │  │  │
│  │  │ • Routing   │  │ • Fleet mgmt│  │ • Per-Smartbox      │  │  │
│  │  │ • Auth      │  │ • Config    │  │   proxy             │  │  │
│  │  │ • Rate limit│  │ • Exec API  │  │ • WebSockets        │  │  │
│  │  └──────┬──────┘  └─────────────┘  └──────────┬──────────┘  │  │
│  │         │                                     │              │  │
│  │         └─────────────────────────────────────┘              │  │
│  │                           │                                  │  │
│  │                   ┌───────▼────────┐                         │  │
│  │                   │  Sandbox DOs   │                         │  │
│  │                   │                │                         │  │
│  │                   │ • PA Smartbox  │                         │  │
│  │                   │ • Project Smart│                         │  │
│  │                   │ • Runtime Smart│                         │  │
│  │                   └────────────────┘                         │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                           │                                         │
│                   ┌───────▼────────┐                                │
│                   │  R2 Storage    │  (Persistent backup)           │
│                   └────────────────┘                                │
│                           ▲                                         │
│                   ┌───────┴────────┐                                │
│                   │  Local GSV     │  (Your machine connector)      │
│                   └────────────────┘                                │
└─────────────────────────────────────────────────────────────────────┘
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed technical documentation.

---

## Features

### Always-On AI
- Runs 24/7 in the cloud (configurable sleep timeout)
- Persistent memory across sessions
- No cold starts for active conversations

### Multi-Channel Access
- **Telegram** — Chat on the go
- **Discord** — For communities and groups
- **Slack** — Workplace integration
- **Web UI** — Full-featured control interface
- **CLI** — Developer-friendly command line

### Multi-Agent System
- **PA Smartbox** — Your main conversational interface
- **Project Smartboxes** — Specialized per project
- **Runtime Smartboxes** — Infrastructure management
- Orchestration layer to coordinate between agents

### Local Connector
- GSV (Gateway Service) on your machine
- Secure outbound connection to your Smartbox
- Access local files, Docker, and APIs
- Your Smartbox doesn't need inbound access to your network

### Persistent Storage
- R2 storage for backup/restore
- Configuration persists across restarts
- Conversation history and memory
- Device pairings and sessions

---

## Requirements

- [Workers Paid plan](https://www.cloudflare.com/plans/developer-platform/) ($5 USD/month) — required for Cloudflare Sandbox containers
- [Anthropic API key](https://console.anthropic.com/) — for Claude access, or use AI Gateway's [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/)

The following Cloudflare features used by this project have free tiers:
- Cloudflare Access (authentication)
- Browser Rendering (for browser navigation)
- AI Gateway (optional, for API routing/analytics)
- R2 Storage (optional, for persistence)

---

## Setting Up Your First Smartbox

### 1. Authentication (Required)

To use the admin UI at `/_admin/` for device management:

1. Enable Cloudflare Access on your worker:
   - Go to [Workers & Pages dashboard](https://dash.cloudflare.com/?to=/:account/workers-and-pages)
   - Select your Worker
   - In **Settings**, enable **Cloudflare Access** on the workers.dev domain
   - Add your email to the allow list

2. Set the Access secrets:
   ```bash
   npx wrangler secret put CF_ACCESS_TEAM_DOMAIN  # e.g., "myteam.cloudflareaccess.com"
   npx wrangler secret put CF_ACCESS_AUD          # Application Audience tag
   ```

### 2. Device Pairing

New devices must be approved before accessing your Smartbox:

1. Connect from a new device (Telegram, browser, etc.)
2. Device appears as "pending" in admin UI
3. Approve the device at `/_admin/`
4. Device can now connect freely

### 3. Enable Persistent Storage (Recommended)

Without R2, your Smartbox data is lost on restart:

1. Create R2 API token:
   - Go to **R2** > **Manage R2 API Tokens**
   - Create token with **Object Read & Write** permissions

2. Set secrets:
   ```bash
   npx wrangler secret put R2_ACCESS_KEY_ID
   npx wrangler secret put R2_SECRET_ACCESS_KEY
   npx wrangler secret put CF_ACCOUNT_ID
   ```

---

## Admin API

Manage your Smartbox fleet programmatically:

```bash
# Check all Smartboxes
curl -H "X-Admin-Secret: $SECRET" \
  https://claw.captainapp.co.uk/api/super/state/dashboard

# Get Smartbox state
curl -H "X-Admin-Secret: $SECRET" \
  https://claw.captainapp.co.uk/api/super/users/{userId}/state/v2

# Restart a Smartbox
curl -X POST -H "X-Admin-Secret: $SECRET" \
  https://claw.captainapp.co.uk/api/super/users/{userId}/restart-async

# Update config
curl -X PATCH -H "X-Admin-Secret: $SECRET" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-3-5-sonnet-20241022"}' \
  https://claw.captainapp.co.uk/api/super/users/{userId}/config
```

See [ADMIN_API.md](./ADMIN_API.md) for complete reference.

---

## Optional: Chat Channels

### Telegram

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npm run deploy
```

### Discord

```bash
npx wrangler secret put DISCORD_BOT_TOKEN
npm run deploy
```

### Slack

```bash
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put SLACK_APP_TOKEN
npm run deploy
```

---

## Optional: Cloudflare AI Gateway

Route API requests through [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/) for caching, rate limiting, and analytics:

1. Create an AI Gateway in the [dashboard](https://dash.cloudflare.com/?to=/:account/ai/ai-gateway/create-gateway)
2. Add a provider (e.g., Anthropic)
3. Set secrets:
   ```bash
   npx wrangler secret put AI_GATEWAY_API_KEY      # Your provider's API key
   npx wrangler secret put AI_GATEWAY_BASE_URL     # Gateway endpoint URL
   ```

The `AI_GATEWAY_*` variables take precedence over `ANTHROPIC_*` if both are set.

---

## Optional: Browser Automation (CDP)

Enable browser automation capabilities:

```bash
npx wrangler secret put CDP_SECRET    # Secure random string
npx wrangler secret put WORKER_URL    # https://your-worker.workers.dev
npm run deploy
```

Endpoints:
- `GET /cdp/json/version` — Browser version
- `GET /cdp/json/list` — List targets
- `GET /cdp/json/new` — Create new target
- `WS /cdp/devtools/browser/{id}` — WebSocket for CDP commands

---

## All Secrets Reference

| Secret | Required | Description |
|--------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes* | Direct Anthropic API key |
| `AI_GATEWAY_API_KEY` | Yes* | API key for AI Gateway (requires `AI_GATEWAY_BASE_URL`) |
| `AI_GATEWAY_BASE_URL` | Yes* | AI Gateway endpoint URL |
| `MOLTBOT_GATEWAY_MASTER_TOKEN` | Yes | Gateway token for authentication |
| `CF_ACCESS_TEAM_DOMAIN` | Yes* | Cloudflare Access team domain |
| `CF_ACCESS_AUD` | Yes* | Cloudflare Access application audience |
| `R2_ACCESS_KEY_ID` | No | R2 access key for persistent storage |
| `R2_SECRET_ACCESS_KEY` | No | R2 secret key |
| `CF_ACCOUNT_ID` | No | Cloudflare account ID (for R2) |
| `TELEGRAM_BOT_TOKEN` | No | Telegram bot token |
| `DISCORD_BOT_TOKEN` | No | Discord bot token |
| `SLACK_BOT_TOKEN` | No | Slack bot token |
| `SLACK_APP_TOKEN` | No | Slack app token |
| `CDP_SECRET` | No | Shared secret for CDP endpoint |
| `WORKER_URL` | No | Public URL of the worker (for CDP) |
| `SANDBOX_SLEEP_AFTER` | No | Container sleep timeout: `never` (default) or `10m`, `1h`, etc. |
| `DEV_MODE` | No | `true` to skip auth (local dev only) |

*One of ANTHROPIC_API_KEY or AI_GATEWAY_* is required. CF_ACCESS_* required for admin UI.

---

## Documentation

| Document | Description |
|----------|-------------|
| [VISION.md](./VISION.md) | High-level Smartbox Platform vision and concepts |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Technical architecture and components |
| [PLATFORM_OVERVIEW.md](./PLATFORM_OVERVIEW.md) | Current platform status and capabilities |
| [ADMIN_API.md](./ADMIN_API.md) | Admin API reference |
| [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) | Common issues and solutions |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Contributing guidelines |

---

## Troubleshooting

**`npm run dev` fails with Unauthorized:**
Enable Cloudflare Containers in the [Containers dashboard](https://dash.cloudflare.com/?to=/:account/workers/containers)

**First request is slow:**
Cold starts take 1-2 minutes. Set `SANDBOX_SLEEP_AFTER=never` to keep containers always-on.

**R2 not mounting:**
Check that all three R2 secrets are set. R2 mounting only works in production, not with `wrangler dev`.

**Access denied on admin routes:**
Ensure `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` are set correctly.

See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for more.

---

## Links

- [OpenClaw](https://github.com/openclaw/openclaw) — The AI assistant that powers Smartboxes
- [OpenClaw Docs](https://docs.openclaw.ai/)
- [Cloudflare Sandbox Docs](https://developers.cloudflare.com/sandbox/)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)

---

## License

[Apache 2.0](./LICENSE)

---

*The Smartbox Platform — Your AI companion in the cloud.*
