# Container Fleet State Tracking

## Overview
Each container has a local folder in `fleet-state/<name>/` with:
- `state.json` - Current state and check-in history
- `goals.md` (optional) - Specific goals for this container
- `notes.md` (optional) - Free-form notes

## Fleet Check System

The 3-hour cron job (`fleet-check-3h-v2`) runs the fleet check which:
1. Queries all 10 containers via admin API
2. Updates individual state files
3. Compares expected vs actual state
4. Raises alerts for anomalies
5. Auto-wakes containers that should be active

## State Files

### `manifest.json`
Master file with expected states and goals for all containers.

### Individual `state.json`
```json
{
  "userId": "...",
  "name": "...",
  "tier": "standard-N",
  "checkIns": [...],
  "alerts": [...],
  "lastCheckIn": {...},
  "notes": "..."
}
```

## Manual Checks

Run a manual fleet check:
```bash
~/openclaw/repos/moltworker/fleet-check.sh
```

## Alert Levels

- **CRITICAL**: Expected active, but error/unresponsive
- **HIGH**: Expected active, idle >30 min
- **MEDIUM**: Expected active, just went idle (auto-wake)
- **LOW**: Expected idle-ok, but active (just note)
