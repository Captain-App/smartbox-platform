# Cost Tracking Implementation for Moltworker Platform

## Summary

This implementation adds cost tracking and monitoring capabilities to the Moltworker platform admin skill. It provides visibility into platform spending across 9 containers with per-user breakdowns and service-level analysis.

## Files Created/Modified

### 1. Core Cost Tracking Library
**File:** `src/lib/cost-tracking.ts` (18,811 bytes)
- Cost calculation logic based on Cloudflare published pricing
- R2 usage tracking per user prefix
- Container activity metrics from sync markers
- Cost summary generation with alerts

**Key Functions:**
- `generateCostSummary()` - Platform-wide cost aggregation
- `getUserCostSummary()` - Per-user cost breakdown
- `calculateCost()` - Pricing calculation using CF rates
- `checkCostThreshold()` - Alert threshold checking
- `getR2UsagePerUser()` - R2 storage aggregation by user
- `getContainerActivityMetrics()` - Activity estimation

### 2. Admin API Routes
**File:** `src/routes/admin.ts` (Modified)

Added 6 new endpoints under `/api/super/cost/*`:

| Endpoint | Description |
|----------|-------------|
| `GET /api/super/cost` | Total cost summary across all users |
| `GET /api/super/cost/users/:id` | Per-user cost breakdown |
| `GET /api/super/cost/service/:service` | Cost by service type (workers, r2, durableObjects) |
| `GET /api/super/cost/trend` | Month-over-month trending |
| `GET /api/super/cost/check` | Check against spending threshold |
| `GET /api/super/cost/rates` | Current Cloudflare pricing rates |

### 3. CLI Integration
**File:** `skills/moltworker-admin/moltworker-admin.sh` (Modified)

Added `cost` subcommand with options:

```bash
./moltworker-admin.sh cost                    # Total platform cost
./moltworker-admin.sh cost --user miles       # Per-user breakdown
./moltworker-admin.sh cost --service r2       # Cost by service
./moltworker-admin.sh cost --trend            # Month-over-month
./moltworker-admin.sh cost --alert 50         # Alert if spend > $50
./moltworker-admin.sh cost --days 7           # Last 7 days
./moltworker-admin.sh cost --rates            # Show pricing rates
```

## Cost Model

Based on Cloudflare published pricing (as of 2025):

### Workers
- $0.50 per million requests
- $12.50 per million GB-seconds

### R2 Object Storage
- $0.015 per GB-month storage
- $0.36 per million operations

### Durable Objects
- $5 per billion requests
- $2.50 per GB-month storage

### Sandbox
- Included in Workers pricing (no additional cost)

## Implementation Approach

### 1. Per-User Cost Estimation
Since Cloudflare doesn't provide per-user billing, costs are estimated using:
- **R2 Storage**: Summed by user prefix (`users/{userId}/*`)
- **Workers Usage**: Estimated from sync activity markers (`.last-sync` files)
- **Activity Correlation**: File count and sync frequency used to estimate request volume

### 2. Data Sources
- **R2 Bucket Listing**: Aggregates storage per user prefix
- **Sync Markers**: `.last-sync` files indicate container activity
- **Hardcoded User List**: 9 known user IDs from `user-lookup.json`

### 3. Limitations
- **Estimated Workers Usage**: Real request counts require CF Analytics API with proper tokens
- **No Historical Data**: Trends are estimated, not historical
- **Approximate GB-seconds**: Based on sync activity, not actual CPU profiling

## API Response Examples

### Total Cost Summary
```json
{
  "period": {
    "start": "2025-01-04T00:00:00Z",
    "end": "2025-02-03T00:00:00Z",
    "days": 30
  },
  "totalCost": 12.45,
  "userCount": 9,
  "serviceCount": 3,
  "userBreakdown": [
    {
      "userId": "fe56406b-a723-43cf-9f19-ba2ffcb135b0",
      "userName": "miles",
      "totalCost": 2.50,
      "percentageOfTotal": 20.08,
      "workers": { "requests": 5000, "gbSeconds": 2.5, "cost": 0.03 },
      "r2": { "storageGB": 1.2, "operations": 120, "cost": 0.02 },
      "durableObjects": { "requests": 0, "storageGB": 0, "cost": 0 }
    }
  ],
  "trends": {
    "vsLastMonth": 0,
    "projectedMonthly": 12.45
  },
  "alerts": []
}
```

### Threshold Check
```json
{
  "check": {
    "threshold": 50,
    "current": 12.45,
    "remaining": 37.55,
    "percentUsed": 24.9,
    "exceeded": false
  },
  "alerts": []
}
```

## CLI Output Examples

### Summary View
```
Platform Cost Summary
=====================
Period: 2025-01-04 to 2025-02-03 (30 days)

Total Cost: $12.45
Projected Monthly: $12.45

Users: 9 | Services: 3

Cost by Service:
  - WORKERS: $8.50 (68.27%)
  - R2: $3.50 (28.11%)
  - DURABLEOBJECTS: $0.45 (3.61%)
  - SANDBOX: $0.00 (0.00%)

Top Users by Cost:
  - miles: $2.50 (20.08%)
  - jack: $1.80 (14.46%)
  - kyla: $1.50 (12.05%)

Alerts:
  [INFO] threshold: Total cost ($12.45) is within budget
```

### Per-User View
```
User Cost Breakdown: miles
===============================
User ID: fe56406b-a723-43cf-9f19-ba2ffcb135b0
Period: 2025-01-04 to 2025-02-03

Total Cost: $2.50
Platform Share: 20.08%

Breakdown:
  Workers:
    Requests: 5000
    GB-seconds: 2.50
    Cost: $0.03
  R2:
    Storage: 1.20 GB
    Operations: 120
    Cost: $0.02
```

### Alert Check
```
Cost Threshold Check
=====================
Threshold: $50
Current: $12.45
Remaining: $37.55
Percent Used: 24.90%
Status: ✓ Within budget
```

## Next Steps / Future Enhancements

1. **Cloudflare Analytics API Integration**
   - Add CF API token configuration
   - Fetch actual Workers request counts
   - Get real GB-seconds metrics

2. **Historical Data Tracking**
   - Store daily cost snapshots in D1
   - Enable true month-over-month comparison
   - Build trend forecasting

3. **Alerting System**
   - Webhook notifications for threshold breaches
   - Scheduled cost reports
   - Anomaly detection

4. **Cost Optimization Recommendations**
   - Identify high-cost users/services
   - Suggest R2 lifecycle policies
   - Recommend container hibernation schedules

## Testing

```bash
# Get total cost
./moltworker-admin.sh cost

# Check specific user
./moltworker-admin.sh cost --user miles

# Check R2 costs specifically
./moltworker-admin.sh cost --service r2

# Alert at $50 threshold
./moltworker-admin.sh cost --alert 50

# Last 7 days only
./moltworker-admin.sh cost --days 7 --json

# Show pricing rates
./moltworker-admin.sh cost --rates
```

## Build Verification

The implementation builds successfully:
```
vite v6.4.1 building SSR bundle for production...
...
dist/moltbot_sandbox/assets/cost-tracking-XCk4ezE5.js  9.83 kB
✓ built in 642ms
```

## Known Issues / Limitations

1. **No Real-Time Workers Metrics**: Workers request counts are estimated from R2 sync activity, not actual API calls
2. **Trending is Estimated**: Month-over-month comparison uses current usage patterns, not historical data
3. **GB-Seconds Approximated**: Compute time estimated based on sync frequency, not actual CPU profiling
4. **Durable Objects**: Currently returns 0 (need DO analytics integration)

## Security

- All cost endpoints require `X-Admin-Secret` header
- No sensitive pricing data exposed publicly
- User IDs and costs are accessible only to admins
