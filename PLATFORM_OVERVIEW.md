# Moltworker Platform Overview

*What it is, what it isn't, and where we stand.*

---

## What Moltworker IS

### Core Purpose
**One Clawd bot per user.**

Each user gets their own isolated container running the full Clawdbot gateway — their own personal AI assistant with persistent memory, custom domains, and independent lifecycle.

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Cloudflare Edge                          │
│  ┌──────────────────────────────────────────────────────┐   │
│  │           moltbot-sandbox Worker                      │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐   │   │
│  │  │  Sandbox 1  │  │  Sandbox 2  │  │  Sandbox N  │   │   │
│  │  │ (User A)    │  │ (User B)    │  │ (User C)    │   │   │
│  │  │             │  │             │  │             │   │   │
│  │  │ • Gateway   │  │ • Gateway   │  │ • Gateway   │   │   │
│  │  │ • R2 Mount  │  │ • R2 Mount  │  │ • R2 Mount  │   │   │
│  │  └─────────────┘  └─────────────┘  └─────────────┘   │   │
│  └──────────────────────────────────────────────────────┘   │
│                          │                                  │
│                    ┌─────┴─────┐                           │
│                    │ R2 Bucket │  (moltbot-data)            │
│                    │  (Backups)│                           │
│                    └───────────┘                           │
└─────────────────────────────────────────────────────────────┘
```

### Components

| Component | Purpose | Status |
|-----------|---------|--------|
| **Worker** | Cloudflare Worker routing requests to containers | ✅ Working |
| **Sandbox** | Docker container per user (openclaw-{userId}) | ✅ Working |
| **Gateway** | Clawdbot gateway inside each container | ✅ Working (with memory fix) |
| **R2 Storage** | Persistent backup/restore | ⚠️ Issues (see below) |
| **Admin API** | Debug endpoints, restarts, logs | ✅ Working |
| **Admin UI** | Web interface for management | ✅ Working |
| **Supabase Auth** | JWT validation for user access | ✅ Working |

### Key Features

1. **Per-user isolation** — Each user gets their own container namespace
2. **Custom domains** — Users can have vanity URLs (e.g., `claw.captainapp.co.uk`)
3. **Persistent storage** — R2 bucket mounted at `/data/moltbot`
4. **Auto-sleep** — Containers sleep after ~15 mins inactivity (saves costs)
5. **Zombie process cleanup** — Built-in cleanup on restart
6. **JWT auth** — Supabase-based authentication

---

## What Moltworker ISN'T

### Not a Kubernetes Cluster
- No orchestration, no pod scheduling
- Just Cloudflare Containers with a Worker router
- Max 20 instances (configurable in wrangler.jsonc)

### Not a Traditional VM
- Containers sleep when idle (not always-on)
- Cold start latency on first request
- Memory limits enforced (OOM kills happen)

### Not a Managed Database
- R2 is object storage, not a database
- No queries, no indexing, just files
- Backup/restore is file-level rsync

### Not Production-Grade (Yet)
- **No health checks** — containers can be "running" but broken
- **No auto-restart on crash** — OOM = dead until manual restart
- **R2 sync is flaky** — backups may not be happening (investigating)
- **No monitoring/alerting** — we only know it's broken when users complain

---

## Current Issues (As of 2026-01-31)

### 1. R2 Backup/Restore — ⚠️ UNKNOWN
**Symptoms:**
- Logs show "R2 not mounted, starting fresh"
- Container restarts with empty config
- Unclear if sync ever worked

**Investigation needed:**
- Check if `moltbot-data` bucket has any objects
- Verify cron trigger is firing (`* * * * *`)
- Check if mountR2Storage() is actually working

### 2. OOM Crashes — ✅ FIXED
**Symptoms:**
- Gateway crashes with "JavaScript heap out of memory"
- 608MB limit hit quickly

**Fix:**
- Increased container instance type from `standard` to `standard-1` (more memory)
- May need `NODE_OPTIONS="--max-old-space-size=4096"` in future

### 3. Zombie Processes — ✅ FIXED
**Symptoms:**
- Old gateway processes accumulate
- New starts fail with port conflicts

**Fix:**
- Added zombie cleanup in `start-moltbot.sh`
- Full cleanup on restart (`pkill -f clawdbot`)

### 4. Deploy Hangs — ✅ FIXED (External)
**Symptoms:**
- `wrangler deploy` hangs at "Starting asset upload"
- Container builds never complete

**Root cause:**
- Cloudflare "Minor Service Outage" on container build service
- Resolved by restarting local Docker daemon

---

## File Structure

```
repos/moltworker/
├── src/
│   ├── index.ts              # Worker entry point
│   ├── gateway/
│   │   ├── index.ts          # Gateway lifecycle management
│   │   ├── sync.ts           # R2 sync logic (⚠️ may be broken)
│   │   ├── r2.ts             # R2 mount utilities
│   │   └── utils.ts          # Process helpers
│   ├── routes/
│   │   ├── api.ts            # Public API routes
│   │   ├── admin.ts          # Admin UI routes
│   │   └── debug.ts          # Debug endpoints
│   └── types.ts              # TypeScript definitions
├── start-moltbot.sh          # Container startup script
├── Dockerfile                # Container image
├── wrangler.jsonc            # Cloudflare configuration
└── ADMIN_API.md              # API documentation
```

---

## Key URLs

| Endpoint | Purpose |
|----------|---------|
| `https://moltbot-sandbox.captainapp.workers.dev` | Main worker |
| `https://moltbot-sandbox.captainapp.workers.dev/admin` | Admin UI |
| `https://moltbot-sandbox.captainapp.workers.dev/debug/admin/users/{userId}` | User debug |
| `https://claw.captainapp.co.uk` | Jack's custom domain |

---

## Next Steps

1. **Verify R2 backups** — Run `wrangler r2 object list moltbot-data`
2. **Add health checks** — Gateway should report status, Worker should check it
3. **Add monitoring** — Alert when containers are down
4. **Fix R2 sync** — Debug why mount/restore isn't working
5. **Document recovery** — How to restore from R2 if we fix it

---

*Last updated: 2026-01-31 by Clawd*
