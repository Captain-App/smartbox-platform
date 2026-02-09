# Moltworker Platform Overview

*What it is, what it isn't, and where we stand.*

---

## What Moltworker IS

### Core Purpose
**One OpenClaw bot per user.**

Each user gets their own isolated container running the full OpenClaw gateway — their own personal AI assistant with persistent memory, custom domains, and independent lifecycle.

### Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Cloudflare Edge                                  │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │           moltworker-platform Worker                          │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐        │   │
│  │  │ Sandbox 1    │  │ Sandbox 2    │  │ Sandbox N    │        │   │
│  │  │ (standard-1) │  │ (standard-3) │  │ (standard-2) │        │   │
│  │  │              │  │              │  │              │        │   │
│  │  │ • Gateway    │  │ • Gateway    │  │ • Gateway    │        │   │
│  │  │ • R2 Backup  │  │ • R2 Backup  │  │ • R2 Backup  │        │   │
│  │  │ • 1 vCPU     │  │ • 4 vCPU     │  │ • 2 vCPU     │        │   │
│  │  │ • 1GB RAM    │  │ • 4GB RAM    │  │ • 2GB RAM    │        │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘        │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                              │                                      │
│                    ┌─────────┴─────────┐                           │
│                    │   R2 Bucket       │  (moltbot-data)            │
│                    │  (Persistence)    │                           │
│                    └───────────────────┘                           │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  CaptainApp Proxy (Optional)                                │   │
│  │  • Per-user API key management                              │   │
│  │  • Usage tracking                                           │   │
│  │  • Rate limiting                                            │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### Components

| Component | Purpose | Status |
|-----------|---------|--------|
| **Worker** | Cloudflare Worker routing requests to containers | ✅ Working |
| **Sandbox** | Docker container per user (openclaw-{userId}) | ✅ Working |
| **Gateway** | OpenClaw gateway inside each container | ✅ Working |
| **R2 Storage** | Persistent backup/restore | ✅ Working |
| **Admin API** | Debug endpoints, restarts, logs | ✅ Working |
| **Admin UI** | Web interface for management | ✅ Working |
| **Supabase Auth** | JWT validation for user access | ✅ Working |
| **Tiered Routing** | standard-1/2/3 instance types | ✅ Working |
| **CaptainApp Proxy** | Per-user API key management | ✅ Working |

### Tiered Routing

Users are assigned to different container tiers based on requirements:

| Tier | vCPU | RAM | Max Instances | Use Case |
|------|------|-----|---------------|----------|
| **standard-1** | 1 | 1GB | 20 | Basic usage, testing |
| **standard-2** | 2 | 2GB | 10 | Regular usage |
| **standard-3** | 4 | 4GB | 5 | Heavy usage, multiple agents |

**Assigning tiers:** Edit `src/gateway/tiers.ts`:
```typescript
setUserTier('user-id-here', 'standard-3');
```

### Key Features

1. **Per-user isolation** — Each user gets their own container namespace
2. **Custom domains** — Users can have vanity URLs (e.g., `claw.captainapp.co.uk`)
3. **Persistent storage** — R2 bucket with tar-based backup/restore
4. **Auto-sleep** — Containers sleep after ~15 mins inactivity (saves costs)
5. **Zombie process cleanup** — Built-in cleanup on restart
6. **JWT auth** — Supabase-based authentication
7. **Zero-data-loss restarts** — Critical files synced before restart
8. **Tiered resources** — Different instance types for different needs

---

## What Moltworker ISN'T

### Not a Kubernetes Cluster
- No orchestration, no pod scheduling
- Just Cloudflare Containers with a Worker router
- Max instances per tier (configurable in wrangler.jsonc)

### Not a Traditional VM
- Containers sleep when idle (not always-on)
- Cold start latency on first request
- Memory limits enforced (OOM kills happen)

### Not a Managed Database
- R2 is object storage, not a database
- No queries, no indexing, just files
- Backup/restore is file-level tar sync

### Not Production-Grade (Yet)
- **No auto-restart on crash** — OOM = dead until manual restart
- **Exec timeouts** — Container exec commands can hang (see troubleshooting)
- **No monitoring/alerting** — we only know it's broken when users complain

---

## Current Status (As of 2026-02-06)

### ✅ Working Well

| Feature | Status | Notes |
|---------|--------|-------|
| Container lifecycle | ✅ | Start, stop, restart working |
| R2 backup/restore | ✅ | Tar-based sync working reliably |
| Tiered routing | ✅ | standard-1/2/3 all functional |
| Admin API | ✅ | Debug and super endpoints working |
| CaptainApp proxy | ✅ | Per-user API keys working |
| Config management | ✅ | openclaw.json in R2 |
| Session persistence | ✅ | Sessions restored from R2 |

### ⚠️ Known Issues

| Issue | Status | Workaround |
|-------|--------|------------|
| **Exec commands timeout** | 🔴 | Use debug endpoints instead of exec |
| Gateway API code error | 🟡 | `startProcess` undefined in some routes |
| Some containers won't start | 🟡 | Destroy and recreate fixes it |

### Migration Status: Clawdbot → OpenClaw

- **Completed**: 6 users migrated (openclaw.json configs)
- **Pending**: 4 users need fresh configs (David Lippold, Adnan, Ben Lippold, Miles)
- **Session restoration**: 135 sessions restored for Jack

---

## File Structure

```
repos/moltworker/
├── src/
│   ├── index.ts              # Worker entry point
│   ├── gateway/
│   │   ├── index.ts          # Gateway lifecycle management
│   │   ├── sync.ts           # R2 tar-based sync
│   │   ├── process.ts        # Process management
│   │   ├── tiers.ts          # Tiered routing assignments
│   │   └── verification.ts   # Backup verification
│   ├── routes/
│   │   ├── api.ts            # Public API routes
│   │   ├── admin.ts          # Admin UI routes
│   │   └── debug.ts          # Debug endpoints
│   └── types.ts              # TypeScript definitions
├── start-moltbot.sh          # Container startup script
├── Dockerfile                # Container image (v21)
├── wrangler.jsonc            # Cloudflare configuration
├── ADMIN_API.md              # Emergency admin API
├── SKILL.md                  # Super admin API
└── TROUBLESHOOTING.md        # Common issues (NEW)
```

---

## Key URLs

| Endpoint | Purpose |
|----------|---------|
| `https://moltworker-platform.captainapp.workers.dev` | Main worker |
| `https://moltworker-platform.captainapp.workers.dev/admin` | Admin UI |
| `https://moltworker-platform.captainapp.workers.dev/debug/admin/users/{userId}` | User debug |
| `https://captainapp-proxy.captainapp.workers.dev` | CaptainApp proxy |

---

## Next Steps

1. **Fix exec timeout** — Debug why container exec hangs
2. **Add monitoring** — Alert when containers are down
3. **Complete migration** — Create configs for remaining 4 users
4. **Document recovery** — Expand troubleshooting guide

---

*Last updated: 2026-02-06*
