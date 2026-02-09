# Moltworker Troubleshooting Guide

Common issues and how to fix them.

---

## Table of Contents

1. [Container Exec Timeout](#container-exec-timeout)
2. [Gateway Failed to Start](#gateway-failed-to-start)
3. [Container Won't Start](#container-wont-start)
4. [R2 Backup Issues](#r2-backup-issues)
5. [High Memory Usage](#high-memory-usage)
6. [Zombie Processes](#zombie-processes)
7. [Telegram Bot Not Responding](#telegram-bot-not-responding)

---

## Container Exec Timeout

### Symptoms
- `POST /api/super/users/:id/exec` hangs and times out
- Even simple commands like `pwd` or `echo test` timeout
- Container shows as "idle" with processes running

### Diagnosis

Check container state:
```bash
curl -H "X-Admin-Secret: $TOKEN" \
  "https://moltworker-platform.captainapp.workers.dev/api/super/users/$USER_ID/state"
```

If state is "idle" with processes > 0, the gateway is likely hanging.

### Solutions

**Option 1: Restart the container**
```bash
curl -X POST -H "X-Admin-Secret: $TOKEN" \
  "https://moltworker-platform.captainapp.workers.dev/debug/admin/users/$USER_ID/restart"
```

**Option 2: Kill zombies and restart**
```bash
# Kill all processes
curl -X POST -H "X-Admin-Secret: $TOKEN" \
  "https://moltworker-platform.captainapp.workers.dev/debug/admin/users/$USER_ID/kill-zombie"

# Wait 5 seconds, then check (auto-restarts)
sleep 5
curl -H "X-Admin-Secret: $TOKEN" \
  "https://moltworker-platform.captainapp.workers.dev/api/super/users/$USER_ID/state"
```

**Option 3: Nuclear - Destroy and recreate**
```bash
# Destroy sandbox entirely
curl -X POST -H "X-Admin-Secret: $TOKEN" \
  "https://moltworker-platform.captainapp.workers.dev/debug/admin/users/$USER_ID/destroy"

# Wait for recreation
sleep 10
curl -H "X-Admin-Secret: $TOKEN" \
  "https://moltworker-platform.captainapp.workers.dev/api/super/users/$USER_ID/state"
```

### Root Causes

1. **Gateway process hanging** - The openclaw gateway inside the container is stuck
2. **Resource exhaustion** - Container hit memory limit (OOM)
3. **R2 sync blocking** - Container waiting on R2 operation
4. **Port conflict** - Old gateway process still holding port 18789

### Prevention

- Enable automatic zombie cleanup in `start-moltbot.sh`
- Monitor memory usage and upgrade tier if needed
- Use restart instead of exec for non-urgent commands

---

## Gateway Failed to Start

### Symptoms
- Container starts but gateway doesn't respond
- Error: `"Moltbot gateway failed to start"`
- Error details: `"Cannot read properties of undefined (reading 'startProcess')"`

### Diagnosis

Check R2 backup for config:
```bash
curl -H "X-Admin-Secret: $TOKEN" \
  "https://moltworker-platform.captainapp.workers.dev/debug/admin/users/$USER_ID/r2-backup"
```

Check container config directly:
```bash
curl -H "X-Admin-Secret: $TOKEN" \
  "https://moltworker-platform.captainapp.workers.dev/debug/admin/users/$USER_ID/config"
```

### Solutions

**If config is empty or missing:**

1. Check R2 for existing config:
```bash
curl -H "X-Admin-Secret: $TOKEN" \
  "https://moltworker-platform.captainapp.workers.dev/debug/admin/users/$USER_ID/r2-backup?path=openclaw/openclaw.json"
```

2. If config exists in R2 but not loading, force a destroy/recreate:
```bash
curl -X POST -H "X-Admin-Secret: $TOKEN" \
  "https://moltworker-platform.captainapp.workers.dev/debug/admin/users/$USER_ID/destroy"
```

3. If no config exists, create one via R2-first API:
```bash
curl -X PUT \
  -H "X-Admin-Secret: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "agents": {
      "defaults": {
        "model": {"primary": "captainapp/kimi-k2.5"},
        "workspace": "/root/.openclaw/workspace"
      }
    },
    "channels": {
      "telegram": {"enabled": true}
    }
  }' \
  "https://moltworker-platform.captainapp.workers.dev/api/super/users/$USER_ID/config"
```

### Root Causes

1. **No config in R2** - First-time user without openclaw.json
2. **Config migration failed** - Old clawdbot config not copied to openclaw path
3. **Corrupted config** - Invalid JSON in openclaw.json
4. **Missing secrets** - No API keys configured

---

## Container Won't Start

### Symptoms
- State shows "stopped" after wake/restart attempts
- Process count stays at 0
- No error messages in responses

### Diagnosis

Check for failed starts:
```bash
curl -H "X-Admin-Secret: $TOKEN" \
  "https://moltworker-platform.captainapp.workers.dev/debug/admin/users/$USER_ID"
```

Look for `failedStarts` count and `recentLogs`.

### Solutions

**Step 1: Force destroy**
```bash
curl -X POST -H "X-Admin-Secret: $TOKEN" \
  "https://moltworker-platform.captainapp.workers.dev/debug/admin/users/$USER_ID/destroy"
```

**Step 2: Wait and check state**
```bash
sleep 10
curl -H "X-Admin-Secret: $TOKEN" \
  "https://moltworker-platform.captainapp.workers.dev/api/super/users/$USER_ID/state"
```

**Step 3: If still stopped, try manual wake**
```bash
curl -X POST -H "X-Admin-Secret: $TOKEN" \
  "https://moltworker-platform.captainapp.workers.dev/api/super/users/$USER_ID/wake"
```

### Root Causes

1. **Sandbox stuck at infrastructure level** - Cloudflare Sandbox issue
2. **Instance limit reached** - Tier's max_instances exceeded
3. **Docker image issue** - Corrupted or missing image
4. **Startup script failure** - start-moltbot.sh exiting early

---

## R2 Backup Issues

### Symptoms
- Config changes lost after restart
- "No R2 backup exists yet" in responses
- Last sync timestamp is old or missing

### Diagnosis

Check backup health:
```bash
curl -H "X-Admin-Secret: $TOKEN" \
  "https://moltworker-platform.captainapp.workers.dev/debug/admin/users/$USER_ID/backup/health"
```

Check sync status:
```bash
curl -H "X-Admin-Secret: $TOKEN" \
  "https://moltworker-platform.captainapp.workers.dev/debug/admin/users/$USER_ID/sync-status"
```

### Solutions

**Force a sync:**
```bash
curl -X POST -H "X-Admin-Secret: $TOKEN" \
  "https://moltworker-platform.captainapp.workers.dev/debug/admin/users/$USER_ID/force-sync"
```

**Verify critical files:**
```bash
curl -H "X-Admin-Secret: $TOKEN" \
  "https://moltworker-platform.captainapp.workers.dev/debug/admin/users/$USER_ID/backup/critical"
```

**Enable shutdown sync** (if disabled):
Edit `src/config/backup.ts`:
```typescript
export const BACKUP_FEATURE_FLAGS = {
  SHUTDOWN_SYNC: true,
  CRITICAL_FILE_PRIORITY: true,
  SYNC_VERIFICATION: true,
  // ...
};
```

### Root Causes

1. **R2 credentials missing** - R2_ACCESS_KEY_ID or R2_SECRET_ACCESS_KEY not set
2. **Feature flags disabled** - Shutdown sync not enabled
3. **Cron not firing** - Worker cron triggers not configured
4. **Container OOM during sync** - Sync aborted due to memory limit

---

## High Memory Usage

### Symptoms
- Container OOMs frequently
- Gateway crashes with "JavaScript heap out of memory"
- Process count grows over time

### Diagnosis

Check current tier assignment:
```bash
# Check src/gateway/tiers.ts for user's tier
```

Monitor via debug endpoints (if exec works):
```bash
curl -H "X-Admin-Secret: $TOKEN" \
  "https://moltworker-platform.captainapp.workers.dev/debug/admin/users/$USER_ID/ps"
```

### Solutions

**Upgrade tier:**
Edit `src/gateway/tiers.ts`:
```typescript
// Move user to higher tier
setUserTier('user-id-here', 'standard-3');
```

Then restart container:
```bash
curl -X POST -H "X-Admin-Secret: $TOKEN" \
  "https://moltworker-platform.captainapp.workers.dev/debug/admin/users/$USER_ID/restart"
```

**Kill zombie processes:**
```bash
curl -X POST -H "X-Admin-Secret: $TOKEN" \
  "https://moltworker-platform.captainapp.workers.dev/debug/admin/users/$USER_ID/kill-zombie"
```

### Root Causes

1. **Wrong tier** - User on standard-1 but needs more memory
2. **Memory leak** - Gateway process accumulating memory
3. **Too many processes** - Zombie processes not being cleaned up
4. **Large file operations** - R2 sync with huge files

---

## Zombie Processes

### Symptoms
- Process count grows over time
- New gateway starts fail with port conflicts
- "Address already in use" errors

### Diagnosis

List processes:
```bash
curl -H "X-Admin-Secret: $TOKEN" \
  "https://moltworker-platform.captainapp.workers.dev/debug/admin/users/$USER_ID/ps"
```

### Solutions

**Kill all zombies:**
```bash
curl -X POST -H "X-Admin-Secret: $TOKEN" \
  "https://moltworker-platform.captainapp.workers.dev/debug/admin/users/$USER_ID/kill-zombie"
```

**Full restart with cleanup:**
```bash
curl -X POST -H "X-Admin-Secret: $TOKEN" \
  "https://moltworker-platform.captainapp.workers.dev/debug/admin/users/$USER_ID/restart"
```

### Prevention

The restart endpoint now includes automatic zombie cleanup. Use restart instead of trying to start a new gateway alongside existing ones.

---

## Telegram Bot Not Responding

### Symptoms
- Telegram messages not being processed
- Bot appears offline in Telegram
- No errors in container logs

### Diagnosis

Check Telegram config:
```bash
curl -H "X-Admin-Secret: $TOKEN" \
  "https://moltworker-platform.captainapp.workers.dev/debug/admin/users/$USER_ID/config" | \
  jq '.channels.telegram'
```

Check secrets:
```bash
curl -H "X-Admin-Secret: $TOKEN" \
  "https://moltworker-platform.captainapp.workers.dev/debug/admin/users/$USER_ID/r2-backup?path=secrets.json"
```

### Solutions

**Fix malformed token:**
```bash
curl -X POST -H "X-Admin-Secret: $TOKEN" \
  "https://moltworker-platform.captainapp.workers.dev/debug/admin/users/$USER_ID/fix-telegram"
```

**Update secrets:**
```bash
curl -X POST \
  -H "X-Admin-Secret: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"TELEGRAM_BOT_TOKEN": "123456:ABC..."}' \
  "https://moltworker-platform.captainapp.workers.dev/debug/admin/users/$USER_ID/fix-secrets"
```

**Restart container:**
```bash
curl -X POST -H "X-Admin-Secret: $TOKEN" \
  "https://moltworker-platform.captainapp.workers.dev/debug/admin/users/$USER_ID/restart"
```

### Root Causes

1. **Malformed token** - Extra text in TELEGRAM_BOT_TOKEN
2. **Bot not paired** - Device pairing not approved in admin UI
3. **Token revoked** - Bot token invalidated by Telegram
4. **Channel disabled** - Telegram channel not enabled in config

---

## Quick Reference: Admin API Token

All commands need the master token:

```bash
export TOKEN="bd2bc65905da06b1dbf4d266f6719997fdebf43727d7382cc9639d475dbf198e"
export USER_ID="5bb7d208-2baf-4c95-8aec-f28e016acedb"
```

Base URL:
```
https://moltworker-platform.captainapp.workers.dev
```

---

## Still Stuck?

1. Check Worker logs: `wrangler tail`
2. Review [PLATFORM_OVERVIEW.md](./PLATFORM_OVERVIEW.md)
3. Check [ADMIN_API.md](./ADMIN_API.md) for all available endpoints
4. File an issue with the output of:
   - Container state endpoint
   - R2 backup endpoint
   - Recent restart logs
