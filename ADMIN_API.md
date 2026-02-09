# Moltworker Admin API

Emergency admin endpoints for managing user containers. These bypass normal auth for operational recovery.

## Authentication

All admin endpoints require the **master token** in the `X-Admin-Secret` header:

```bash
X-Admin-Secret: your-moltbot-gateway-master-token
```

The master token is set via Wrangler secret:
```bash
wrangler secret put MOLTBOT_GATEWAY_MASTER_TOKEN
```

**Note:** Earlier versions used derived per-user tokens. This has been simplified - use the master token directly for all endpoints.

## Endpoints

### List all users
```bash
GET /debug/admin/users
Header: X-Admin-Secret: <master-token>
```

Returns all users from Supabase profiles with their sandbox status.

### Get user + sandbox status
```bash
GET /debug/admin/users/:userId
Header: X-Admin-Secret: <master-token>
```

Returns:
- Container active status
- Process count
- Failed start count
- Recent logs (if any failed starts)

### Restart user's container
```bash
POST /debug/admin/users/:userId/restart
Header: X-Admin-Secret: <master-token>
```

**Features:**
- Zero-data-loss: Pre-shutdown sync ensures credentials are saved
- Zombie cleanup: Kills all existing processes before restart
- Telegram token fix: Automatically fixes malformed tokens

Response:
```json
{
  "success": true,
  "message": "Container restart initiated",
  "userId": "...",
  "killedProcesses": 10,
  "shutdownSync": {
    "enabled": true,
    "success": true
  }
}
```

### Kill zombie processes
```bash
POST /debug/admin/users/:userId/kill-zombie
Header: X-Admin-Secret: <master-token>
```

Kills all processes in the sandbox via the sandbox API (no shell commands).

### Force destroy sandbox
```bash
POST /debug/admin/users/:userId/destroy
Header: X-Admin-Secret: <master-token>
```

**Nuclear option:** Destroys the sandbox entirely. It will be recreated on the next request. Use when:
- Container is completely stuck
- Restart doesn't work
- You need a completely fresh start

### Get R2 backup status
```bash
GET /debug/admin/users/:userId/r2-backup
Header: X-Admin-Secret: <master-token>
```

Returns:
- Whether backup exists in R2
- Last sync timestamp
- List of all files in R2 for this user
- Current config (if exists)

### Get container config
```bash
GET /debug/admin/users/:userId/config
Header: X-Admin-Secret: <master-token>
```

Reads the actual `openclaw.json` from inside the container.

### Fix Telegram token
```bash
POST /debug/admin/users/:userId/fix-telegram
Header: X-Admin-Secret: <master-token>
```

Extracts clean Telegram token from malformed input (removes extra text).

### Fix secrets
```bash
POST /debug/admin/users/:userId/fix-secrets
Content-Type: application/json
Header: X-Admin-Secret: <master-token>

{
  "TELEGRAM_BOT_TOKEN": "123456:ABC...",
  "OPENAI_API_KEY": "sk-..."
}
```

Updates secrets in R2 directly.

## Quick Reference: Common Operations

### Restart a stuck container
```bash
TOKEN="your-master-token"
USER_ID="5bb7d208-2baf-4c95-8aec-f28e016acedb"

curl -X POST \
  -H "X-Admin-Secret: $TOKEN" \
  "https://moltworker-platform.captainapp.workers.dev/debug/admin/users/$USER_ID/restart"
```

### Check if container is running
```bash
curl -H "X-Admin-Secret: $TOKEN" \
  "https://moltworker-platform.captainapp.workers.dev/debug/admin/users/$USER_ID"
```

### Destroy and recreate a broken container
```bash
# Step 1: Destroy
curl -X POST \
  -H "X-Admin-Secret: $TOKEN" \
  "https://moltworker-platform.captainapp.workers.dev/debug/admin/users/$USER_ID/destroy"

# Step 2: Wait 5 seconds

# Step 3: Check (this will recreate it)
curl -H "X-Admin-Secret: $TOKEN" \
  "https://moltworker-platform.captainapp.workers.dev/debug/admin/users/$USER_ID"
```

## Security Notes

- These endpoints are on `/debug/admin/*` which bypasses CF Access
- DEBUG_ROUTES must be enabled (`wrangler secret put DEBUG_ROUTES = true`)
- The master token grants full access to all containers - keep it secure
- Endpoints are designed for emergency operational recovery

## See Also

- [Super Admin API](./SKILL.md) - State-aware API with auto-wake
- [Platform Overview](./PLATFORM_OVERVIEW.md) - Architecture and components
- [Troubleshooting Guide](./TROUBLESHOOTING.md) - Common issues and fixes
