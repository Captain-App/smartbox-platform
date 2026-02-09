# Moltworker Architecture Implementation - Summary

## ✅ Completed Phases

### Phase 1: Shared Types ✅
Created `packages/shared/` with:
- **types.ts** - All TypeScript interfaces (users, environments, DO types, API responses)
- **auth.ts** - Authentication utilities (Supabase JWT, admin secret validation, tiered routing)
- **utils.ts** - Helper functions (logging, time, strings, objects, arrays, responses)
- **constants.ts** - Constants (ports, timeouts, rate limits, feature flags, user registry)

### Phase 2: Admin API Worker ✅
Created `workers/admin-api/` with:
- **ExecResultStore DO** - SQLite-backed Durable Object for persistent exec results
  - Schema: exec_results table with indexes
  - Auto-cleanup of old results
  - Max 100 results per user
- **Admin Routes** - All `/api/super/*` endpoints
  - User registry (list, lookup)
  - R2-only endpoints (r2-status, r2-health)
  - Container state (state, state/v2, dashboard)
  - Lifecycle (restart-async, bulk/restart)
  - Exec with DO persistence (exec, exec/status)
  - Config management (get, put, patch, bulk)
- **Wrangler config** - Complete configuration with DO, R2, containers, D1, KV

### Phase 3: Container Gateway Worker ✅
Created `workers/container-gateway/` with:
- **Authentication** - Supabase JWT validation
- **Sandbox initialization** - Per-user sandbox with tiered routing
- **WebSocket handling** - Full WS proxy with token injection
- **HTTP proxy** - Container fetch with HTML injection
- **Loading page** - For cold starts

### Phase 4: Edge Router Worker ✅
Created `workers/router/` with:
- **Request routing** - Routes to Admin API or Container Gateway
- **Rate limiting** - KV-based rate limiting (60 req/min)
- **Feature flags** - `USE_NEW_ADMIN_API`, `USE_NEW_CONTAINER_GATEWAY`
- **Auth middleware** - Validates tokens before routing

### Phase 5: Migration & Testing ✅
Created migration scripts:
- **enable-new-architecture.mjs** - Deploys workers, enables admin API
- **enable-container-gateway.mjs** - Enables container gateway after validation
- **rollback-architecture.mjs** - Disables new workers, returns to legacy

## 📁 File Structure

```
moltworker/
├── packages/
│   └── shared/
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts
│           ├── types.ts
│           ├── auth.ts
│           ├── utils.ts
│           └── constants.ts
├── workers/
│   ├── admin-api/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── wrangler.jsonc
│   │   └── src/
│   │       ├── index.ts
│   │       ├── routes/
│   │       │   └── admin.ts
│   │       └── durable-objects/
│   │           └── exec-result-store.ts
│   ├── container-gateway/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── wrangler.jsonc
│   │   └── src/
│   │       └── index.ts
│   └── router/
│       ├── package.json
│       ├── tsconfig.json
│       ├── wrangler.jsonc
│       └── src/
│           └── index.ts
├── scripts/
│   ├── enable-new-architecture.mjs
│   ├── enable-container-gateway.mjs
│   └── rollback-architecture.mjs
├── ARCHITECTURE.md
└── package-workspace.json
```

## 🚀 Deployment Instructions

### 1. Deploy Shared Package
```bash
cd packages/shared
npm install
npm run typecheck
```

### 2. Deploy Admin API Worker
```bash
cd workers/admin-api
npm install
# Set secrets
wrangler secret put SUPABASE_JWT_SECRET
wrangler secret put MOLTBOT_GATEWAY_MASTER_TOKEN
# Deploy
wrangler deploy
```

### 3. Deploy Container Gateway Worker
```bash
cd workers/container-gateway
npm install
# Set secrets
wrangler secret put SUPABASE_JWT_SECRET
wrangler secret put MOLTBOT_GATEWAY_MASTER_TOKEN
# Deploy
wrangler deploy
```

### 4. Deploy Router Worker
```bash
cd workers/router
npm install
# Set secrets
wrangler secret put SUPABASE_JWT_SECRET
# Deploy
wrangler deploy
```

### 5. Enable New Architecture
```bash
# Enable gradually (admin API first)
node scripts/enable-new-architecture.mjs

# After validation, enable container gateway
node scripts/enable-container-gateway.mjs
```

## 🔧 Configuration

### Router Feature Flags
Edit `workers/router/wrangler.jsonc`:
```json
{
  "vars": {
    "USE_NEW_ADMIN_API": "true",
    "USE_NEW_CONTAINER_GATEWAY": "false"
  }
}
```

### Admin API Durable Object Migration
The ExecResultStore DO requires a migration:
```json
{
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["ExecResultStore"]
    }
  ]
}
```

## 🔄 Zero-Downtime Migration

1. **Deploy workers** (no traffic change)
2. **Enable admin API** (`USE_NEW_ADMIN_API: true`)
3. **Test admin endpoints** (`/api/super/state/dashboard`)
4. **Enable container gateway** (`USE_NEW_CONTAINER_GATEWAY: true`)
5. **Monitor** for errors

If issues arise:
```bash
node scripts/rollback-architecture.mjs
```

## 📝 Key Changes

### Exec Results Persistence
- **Before**: In-memory Map (lost on worker restart)
- **After**: Durable Object with SQLite (persistent)

### Architecture Separation
- **Before**: Single worker handles everything
- **After**: 
  - Router: Entry point, auth, routing
  - Admin API: Fleet management, exec results
  - Container Gateway: User containers, WebSockets

### Benefits
1. **Exec results persist** across worker restarts
2. **Independent scaling** of admin vs container workloads
3. **Zero-downtime deployments** via feature flags
4. **Better monitoring** with separate workers
5. **Easier testing** with isolated components

## ⚠️ Important Notes

1. **Service Bindings**: Router depends on Admin API and Container Gateway being deployed first

2. **Durable Object**: ExecResultStore uses SQLite - ensure `new_sqlite_classes` migration is applied

3. **Secrets**: Each worker needs its own secrets set via `wrangler secret put`

4. **Routes**: The Router worker has routes configured for `claw.captainapp.co.uk/*`

5. **KV Namespace**: Router uses `RATE_LIMIT_KV` - create this if rate limiting is needed

6. **Tiered Routing**: Both Admin API and Container Gateway support tiered sandbox routing

7. **User Registry**: Currently hardcoded in constants.ts - could be moved to D1

## 🔍 Testing

```bash
# Health check
curl https://claw.captainapp.co.uk/health

# Admin API (with secret)
curl -H "X-Admin-Secret: $SECRET" \
     https://claw.captainapp.co.uk/api/super/state/dashboard

# Exec command
curl -X POST -H "X-Admin-Secret: $SECRET" \
     -H "Content-Type: application/json" \
     -d '{"command": "echo hello"}' \
     https://claw.captainapp.co.uk/api/super/users/{userId}/exec

# Check exec status
curl -H "X-Admin-Secret: $SECRET" \
     https://claw.captainapp.co.uk/api/super/users/{userId}/exec/{execId}/status
```

## 📊 Monitoring

View logs per worker:
```bash
wrangler tail --name moltworker-router
wrangler tail --name moltworker-admin-api
wrangler tail --name moltworker-container-gateway
```

## 🎯 Next Steps

1. Deploy all workers to production
2. Run validation tests
3. Enable feature flags gradually
4. Monitor error rates and latency
5. After 24-48 hours of stability, consider legacy worker removal
