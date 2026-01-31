# Moltworker Admin API

Emergency admin endpoints for managing user containers. These bypass normal auth for operational recovery.

## Authentication

All admin endpoints require the **DERIVED per-user gateway token** in the `X-Admin-Secret` header.

### How to get a user's token

The per-user token is derived via HMAC-SHA256:

```javascript
const token = await deriveUserGatewayToken(masterSecret, userId);
// Returns: hex-encoded HMAC-SHA256(masterSecret, `gateway-token:${userId}`)
```

**Important:** Use the DERIVED token, not the master `MOLTBOT_GATEWAY_MASTER_TOKEN`.

## Endpoints

### List all users
```bash
GET /debug/admin/users
Header: X-Admin-Secret: <any-derived-token-or-master-for-now>
```

### Get user + sandbox status
```bash
GET /debug/admin/users/:userId
Header: X-Admin-Secret: <derived-token-for-this-user>
```

### Restart user's container
```bash
POST /debug/admin/users/:userId/restart
Header: X-Admin-Secret: <derived-token-for-this-user>
```

## Example: Restart Josh's container

```bash
# 1. Get the service role key (for querying Supabase)
SERVICE_ROLE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."

# 2. Find Josh's user ID
 curl "https://kjbcjkihxskuwwfdqklt.supabase.co/rest/v1/profiles?select=id,username,full_name&full_name=ilike.*Josh*" \
   -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
   -H "apikey: $SERVICE_ROLE_KEY"

# 3. Restart his container (auth temporarily bypassed for emergency)
curl -X POST "https://moltbot-sandbox.captainapp.workers.dev/debug/admin/users/81bf6a68-28fe-48ef-b257-f9ad013e6298/restart"
```

## Security Notes

- These endpoints are on `/debug/admin/*` which bypasses CF Access
- DEBUG_ROUTES must be enabled (`wrangler secret put DEBUG_ROUTES = true`)
- Auth uses per-user derived tokens (not the master secret)
- For emergency access, auth can be temporarily disabled in code
