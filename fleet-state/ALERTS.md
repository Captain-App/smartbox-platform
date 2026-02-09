# Container Fleet Alerts

Last Updated: 2026-02-07T13:38:00Z

## Active Alerts

| User | Severity | Issue | Detected | Status |
|------|----------|-------|----------|--------|
| josh | medium | Container idle but expected active | 2026-02-07T13:38Z | Restart initiated |

## Recent Resolutions

None

## Alert Rules

1. **CRITICAL**: Container expected `active` but state is `error` or unresponsive
2. **HIGH**: Container expected `active` but state is `idle` for >30 min
3. **MEDIUM**: Container expected `active` but state is `idle` (immediate wake)
4. **LOW**: Container expected `idle-ok` but state is `active` (just note, no action)
5. **INFO**: Process count anomalies (sudden spikes/drops)
