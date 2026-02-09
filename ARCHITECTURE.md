# Smartbox Platform Architecture

> Technical architecture for the Smartbox Platform — a multi-agent AI system running on Cloudflare.

## Overview

The Smartbox Platform implements the [Vision](./VISION.md) using Cloudflare's edge infrastructure. Each Smartbox is an isolated OpenClay gateway running in a Cloudflare Sandbox container.

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Smartbox Platform Architecture                   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                    Cloudflare Edge                            │  │
│  │                                                              │  │
│  │  ┌────────────────────────────────────────────────────────┐  │  │
│  │  │                 Edge Router Worker                      │  │  │
│  │  │  - Request routing to appropriate Smartbox              │  │  │
│  │  │  - Authentication validation (JWT + device pairing)     │  │  │
│  │  │  - Rate limiting per user                               │  │  │
│  │  │  - Feature flags for zero-downtime migration            │  │  │
│  │  └──────────────┬────────────────────────────────┬─────────┘  │  │
│  │                 │                                │             │  │
│  │         ┌───────▼───────┐              ┌────────▼────────┐    │  │
│  │         │  Admin API    │              │ Container       │    │  │
│  │         │  Worker       │              │ Gateway Worker  │    │  │
│  │         │               │              │                 │    │  │
│  │         │ - Fleet mgmt  │              │ - Per-Smartbox  │    │  │
│  │         │ - Config API  │              │   proxy         │    │  │
│  │         │ - Exec API    │              │ - WebSocket     │    │  │
│  │         │ - DO-backed   │              │   proxy         │    │  │
│  │         │   results     │              │ - Container     │    │  │
│  │         │               │              │   lifecycle     │    │  │
│  │         └───────┬───────┘              └────────┬────────┘    │  │
│  │                 │                               │             │  │
│  │         ┌───────▼───────┐              ┌────────▼────────┐    │  │
│  │         │ ExecResultStore│             │   Sandbox DOs   │    │  │
│  │         │   (Durable     │             │                 │    │  │
│  │         │    Object)     │             │ • PA Smartbox   │    │  │
│  │         │                │             │ • Project Smart │    │  │
│  │         └────────────────┘             │ • Runtime Smart │    │  │
│  │                                        └─────────────────┘    │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                           │                                         │
│                   ┌───────▼────────┐                                │
│                   │  R2 Storage    │  (Persistent backup)           │
│                   │  (moltbot-data)│                                │
│                   └────────────────┘                                │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Core Concepts

### Smartbox

A **Smartbox** is a single OpenClaw gateway instance running in an isolated Cloudflare Sandbox container:

- **Always-on** (configurable sleep timeout)
- **Persistent** (R2 backup/restore)
- **Isolated** (one container per Smartbox)
- **Multi-channel** (Telegram, Discord, Slack, WebSocket)

### Smartbox Types

| Type | Container Name | Purpose |
|------|----------------|---------|
| **PA Smartbox** | `openclaw-{userId}` | Personal assistant, main entry point |
| **Project Smartbox** | `project-{projectId}-{userId}` | Specialized for a specific project |
| **Runtime Smartbox** | `runtime-{userId}` | Infrastructure and operations |
| **Custom Smartbox** | `custom-{type}-{userId}` | Any specialized agent |

### Local Connector (GSV)

The **Local Connector** is the user's local Gateway Service that:
- Maintains an **outbound** WebSocket connection to their Smartbox
- Provides secure access to local resources (files, Docker, APIs)
- Enables bidirectional communication without exposing local network

```
User's Machine                    Cloud
┌─────────────┐                  ┌─────────────┐
│  Local GSV  │ ──WebSocket────► │  Smartbox   │
│             │    (outbound)    │             │
│ • Files     │                  │ • Agents    │
│ • Docker    │◄─Commands───────│ • Memory    │
│ • Local APIs│                  │ • Skills    │
└─────────────┘                  └─────────────┘
```

---

## Components

### 1. Edge Router Worker (`workers/router/`)

Entry point for all requests. Routes traffic to the appropriate backend.

**Routes:**
| Path | Destination | Description |
|------|-------------|-------------|
| `/health` | Router | Health check |
| `/api/super/*` | Admin API | Fleet management endpoints |
| `/*` | Container Gateway | Smartbox proxy and WebSocket |

**Feature Flags:**
- `USE_NEW_ADMIN_API` — Route admin requests to new worker
- `USE_NEW_CONTAINER_GATEWAY` — Route container requests to new worker

### 2. Admin API Worker (`workers/admin-api/`)

Fleet management API for platform administrators.

**Capabilities:**
- **Container State** — Get Smartbox status and health
- **Config Management** — Read/write Smartbox configuration
- **Exec API** — Run commands inside Smartbox containers
- **Bulk Operations** — Restart all, patch config fleet-wide

**Key Endpoints:**
```
GET  /api/super/state/dashboard       # All containers summary
GET  /api/super/users/:id/state/v2    # Live Smartbox state
GET  /api/super/users/:id/config      # Get Smartbox config
PATCH /api/super/users/:id/config     # Update config
POST /api/super/users/:id/exec        # Execute command
POST /api/super/users/:id/restart-async # Restart Smartbox
POST /api/super/bulk/restart          # Restart all Smartboxes
```

**Durable Object:**
- `ExecResultStore` — SQLite-backed storage for exec results
  - Auto-expires after 24 hours
  - Max 100 results per Smartbox

### 3. Container Gateway Worker (`workers/container-gateway/`)

Per-Smartbox proxy and WebSocket handling.

**Key Features:**
- **Supabase JWT Authentication** — Validates user identity
- **Per-Smartbox Routing** — Routes to correct Sandbox DO
- **WebSocket Proxy** — Real-time bidirectional communication
- **Token Injection** — Injects gateway token for auth
- **Cold Start Handling** — Shows loading page during startup

**Authentication Flow:**
1. Request arrives with JWT (Cookie or Bearer)
2. Container Gateway validates with Supabase
3. Extracts user ID from JWT
4. Routes to user's Smartbox container
5. Injects gateway token for Smartbox internal auth

### 4. Sandbox Durable Objects

Cloudflare Sandbox containers running OpenClaw.

**Container Tiers:**
| Tier | vCPU | RAM | Max Instances | Use Case |
|------|------|-----|---------------|----------|
| standard-1 | 1 | 1GB | 20 | Basic PA Smartbox |
| standard-2 | 2 | 2GB | 10 | Power users, Project Smartboxes |
| standard-3 | 4 | 4GB | 5 | Runtime Smartboxes, heavy workloads |

**Lifecycle:**
```
Stopped ──► Starting ──► Running ──► Sleeping ──► Stopped
    ▲                                        │
    └──────── Request received ──────────────┘
```

**R2 Persistence:**
- Backup runs every 5 minutes (cron)
- Restore on container startup
- Tar-based file sync

### 5. Shared Package (`packages/shared/`)

Common types and utilities used across all workers.

**Exports:**
- `types` — TypeScript interfaces (Smartbox, User, Config)
- `auth` — JWT validation, device pairing
- `utils` — Helper functions
- `constants` — Feature flags, tier limits

---

## Data Flow

### User Request Flow

```
User (Telegram/Browser/CLI)
           │
           ▼
┌─────────────────────┐
│   Cloudflare Edge   │
│  ┌───────────────┐  │
│  │ Edge Router   │  │
│  └───────┬───────┘  │
│          │          │
│  ┌───────▼───────┐  │
│  │   Container   │  │
│  │    Gateway    │  │
│  └───────┬───────┘  │
│          │          │
│  ┌───────▼───────┐  │
│  │  Sandbox DO   │  │
│  │  (Smartbox)   │  │
│  └───────┬───────┘  │
└──────────┼──────────┘
           ▼
    OpenClaw Gateway
           │
    ┌──────┴──────┐
    ▼             ▼
  Agent        Local GSV
  Response     (if needed)
```

### Admin Command Flow

```
Admin CLI/Script
       │
       ▼
┌─────────────────────┐
│   Cloudflare Edge   │
│  ┌───────────────┐  │
│  │ Edge Router   │  │
│  └───────┬───────┘  │
│          │          │
│  ┌───────▼───────┐  │
│  │   Admin API   │  │
│  └───────┬───────┘  │
│          │          │
│  ┌───────▼───────┐  │
│  │ ExecResultStore│  │
│  │   (DO)        │  │
│  └───────────────┘  │
└─────────────────────┘
       │
       ▼
  Smartbox Container
       │
       ▼
   Command Result
```

---

## Authentication & Security

### Multi-Layer Security Model

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 1: Transport                                          │
│ - HTTPS/WSS only                                            │
│ - Cloudflare edge SSL termination                           │
├─────────────────────────────────────────────────────────────┤
│ Layer 2: Edge Router                                        │
│ - Rate limiting per IP/user                                 │
│ - DDoS protection                                           │
├─────────────────────────────────────────────────────────────┤
│ Layer 3: Admin API                                          │
│ - X-Admin-Secret header required                            │
│ - Cloudflare Access (optional)                              │
├─────────────────────────────────────────────────────────────┤
│ Layer 4: Container Gateway                                  │
│ - Supabase JWT validation                                   │
│ - Device pairing (pending/approved)                         │
├─────────────────────────────────────────────────────────────┤
│ Layer 5: Smartbox                                           │
│ - Gateway token validation                                  │
│ - Local GSV authentication                                  │
└─────────────────────────────────────────────────────────────┘
```

### Device Pairing

New devices must be explicitly approved before accessing a Smartbox:

1. Device connects with valid JWT
2. Connection held in "pending" state
3. Admin approves device via admin UI or API
4. Device marked as "paired"
5. Future connections allowed immediately

---

## Inter-Smartbox Communication (Future)

### Current State

Each Smartbox is independent. The PA Smartbox acts as the orchestrator.

### Planned: Smartbox Mesh Protocol

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Smartbox Mesh                                  │
│                                                                      │
│   ┌─────────────┐                    ┌─────────────┐               │
│   │ PA Smartbox │◄─────messages─────►│Project Smart│               │
│   │   (User)    │      (async)       │    (Code)   │               │
│   └──────┬──────┘                    └─────────────┘               │
│          │                                                          │
│          │         ┌─────────────┐                                 │
│          └────────►│Runtime Smart│                                 │
│                    │  (Infra)    │                                 │
│                    └─────────────┘                                 │
│                                                                      │
│   Message Types:                                                     │
│   • DELEGATE — PA asks Project Smartbox to handle task            │
│   • QUERY — Smartbox asks another for information                  │
│   • NOTIFY — Async completion notification                          │
│   • BROADCAST — Message to all Smartboxes                           │
└─────────────────────────────────────────────────────────────────────┘
```

**Implementation Options:**
1. **Shared Durable Object** — Central message bus
2. **Direct WebSocket** — P2P connections between Smartboxes
3. **Pub/Sub** — Cloudflare Pub/Sub or similar

---

## Deployment

### Prerequisites

- Cloudflare account with Workers Paid plan ($5/month)
- Wrangler CLI configured
- R2 bucket `moltbot-data`
- D1 database `moltworker-platform`
- KV namespace for rate limiting

### Deploy All Workers

```bash
# Deploy the complete architecture
npm run deploy:all

# Or individually:
npm run deploy:admin-api
npm run deploy:container-gateway
npm run deploy:router
```

### Migration Steps

1. **Deploy new workers** (safe, no traffic):
   ```bash
   node scripts/enable-new-architecture.mjs
   ```

2. **Enable Admin API:**
   Edit `workers/router/wrangler.jsonc`:
   ```json
   "vars": {
     "USE_NEW_ADMIN_API": "true",
     "USE_NEW_CONTAINER_GATEWAY": "false"
   }
   ```

3. **Test Admin API:**
   ```bash
   curl -H "X-Admin-Secret: $SECRET" \
        https://claw.captainapp.co.uk/api/super/state/dashboard
   ```

4. **Enable Container Gateway:**
   ```bash
   node scripts/enable-container-gateway.mjs
   ```

5. **Validation:**
   - Test WebSocket connections
   - Test container proxy
   - Monitor error rates

### Rollback

```bash
node scripts/rollback-architecture.mjs
```

---

## Monitoring & Observability

### Key Metrics

| Component | Metric | Source |
|-----------|--------|--------|
| Router | Request count, error rate, P95 latency | Cloudflare Analytics |
| Admin API | Exec duration, DO storage | Worker logs |
| Container Gateway | Container start time, WS connections | Worker logs |
| Smartbox | Gateway uptime, memory usage | Internal metrics |

### Logs

```bash
# Router
wrangler tail --name moltworker-router

# Admin API
wrangler tail --name moltworker-admin-api

# Container Gateway
wrangler tail --name moltworker-container-gateway
```

### Health Checks

- **Router:** `GET /health` — Returns 200 if healthy
- **Smartbox:** `GET /api/status` — Returns gateway status
- **Admin API:** `GET /api/super/health` — Returns fleet status

---

## Troubleshooting

### Common Issues

**1. Smartbox not responding:**
```bash
# Check container state
curl -H "X-Admin-Secret: $SECRET" \
  https://claw.captainapp.co.uk/api/super/users/{userId}/state/v2

# Restart if needed
curl -X POST -H "X-Admin-Secret: $SECRET" \
  https://claw.captainapp.co.uk/api/super/users/{userId}/restart-async
```

**2. Authentication failures:**
- Verify `SUPABASE_JWT_SECRET` is set
- Check token format (Bearer vs Cookie)
- Confirm device is paired (not pending)

**3. R2 not mounting:**
- Check all three R2 secrets are set
- Verify `CF_ACCOUNT_ID` matches R2 token

**4. Local GSV not connecting:**
- Check gateway token is correct
- Verify Smartbox is running
- Check firewall/WebSocket proxy settings

### Debug Mode

Enable debug logging:
```json
{
  "vars": {
    "DEBUG_ROUTES": "true"
  }
}
```

---

## Future Improvements

1. **Gradual Rollout** — Use Cloudflare's gradual rollout feature
2. **Circuit Breakers** — Add circuit breakers for service calls
3. **Caching Layer** — Cache frequently accessed Smartbox data
4. **Metrics Export** — Export to analytics platform
5. **Auto-scaling** — Dynamic tier assignment based on load
6. **Smartbox Mesh** — Inter-Smartbox messaging protocol

---

## References

- [Vision](./VISION.md) — High-level Smartbox Platform vision
- [PLATFORM_OVERVIEW.md](./PLATFORM_OVERVIEW.md) — Current platform status
- [ADMIN_API.md](./ADMIN_API.md) — Emergency admin API reference
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — Common issues and fixes
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/)
- [OpenClaw](https://github.com/openclaw/openclaw)

---

*Last updated: 2026-02-08*
