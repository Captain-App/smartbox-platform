# ghostly-projects Skill

Fetch and manage projects from the ghostly-chat-skeleton backend (Captain App's main API).

## Overview

This skill provides CLI access to the ghostly-chat-skeleton Supabase backend, allowing you to:
- List all projects
- Get project details (requirements, sprints, team members)
- Search projects
- Create and manage project shares

## Prerequisites

Environment variables (should be in your env):
- `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_ANON_KEY`
- `SUPABASE_PROJECT_ID` (kjbcjkihxskuwwfdqklt)

## Installation

```bash
# Install Supabase CLI (if not already installed)
npm install -g supabase
```

## Usage

### List All Projects
```bash
# Using curl with service role key
curl "https://kjbcjkihxskuwwfdqklt.supabase.co/rest/v1/projects?select=*" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"

# Or via custom domain
curl "https://app.captainapp.co.uk/rest/v1/projects?select=*" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```

### Get Project with Details
```bash
# Get project + requirements + sprints
curl "https://app.captainapp.co.uk/rest/v1/projects?id=eq.{project_id}&select=*,requirements(*),sprints(*)" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```

### Search Projects
```bash
# Search by name or description
curl "https://app.captainapp.co.uk/rest/v1/projects?or=(name.ilike.*{search}*,description.ilike.*{search}*)&select=*" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```

### Get Project Team Members
```bash
# Get users associated with a project
curl "https://app.captainapp.co.uk/rest/v1/project_shares?project_id=eq.{project_id}&select=*,profiles:user_id(*)" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```

## API Endpoints

### REST API (Supabase PostgREST)
- Base: `https://app.captainapp.co.uk/rest/v1/`
- Tables: `projects`, `requirements`, `sprints`, `project_shares`, `profiles`

### Edge Functions
- Base: `https://app.captainapp.co.uk/functions/v1/`
- Admin: `admin-search-projects`, `get-project-users`, `admin-create-project-share`

## Common Queries

### Projects with Linear Integration
```bash
curl "https://app.captainapp.co.uk/rest/v1/projects?not.linear_team_id,is.null&select=*" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```

### Active Sprints
```bash
curl "https://app.captainapp.co.uk/rest/v1/sprints?start_date=lte.{today}&end_date=gte.{today}&select=*,projects(name)" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```

### Requirements by Status
```bash
curl "https://app.captainapp.co.uk/rest/v1/requirements?status=eq.{status}&select=*,projects(name)" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```

## Response Format

Projects table schema:
```json
{
  "id": "uuid",
  "name": "string",
  "description": "string",
  "linear_team_id": "string|null",
  "linear_project_id": "string|null",
  "created_at": "timestamp",
  "updated_at": "timestamp"
}
```

Requirements table schema:
```json
{
  "id": "uuid",
  "project_id": "uuid",
  "title": "string",
  "description": "string",
  "status": "string",
  "created_at": "timestamp",
  "updated_at": "timestamp"
}
```

## Dogfooding Notes

- This skill uses the same API that powers the Captain App
- If something breaks, document it in `infrastructure/ghostly-api-issues.md`
- Rate limits: Standard Supabase limits apply
- Auth: Service role key bypasses RLS (use carefully)

## Troubleshooting

### 401 Unauthorized
- Check that `SUPABASE_SERVICE_ROLE_KEY` is set
- Verify the key hasn't expired

### 404 Not Found
- Table doesn't exist or name is wrong
- Check pluralization (`projects` not `project`)

### 400 Bad Request
- Invalid query syntax
- Check PostgREST query syntax

## Future Enhancements

- [ ] Add WebSocket subscriptions for real-time project updates
- [ ] Cache project list locally
- [ ] Add project creation/update via edge functions
- [ ] Integration with Linear sync functions
- [ ] Project template cloning

## References

- Full API docs: `infrastructure/ghostly-chat-skeleton-api-documentation.md`
- Repo: `/Users/crew/Documents/ghostly-chat-skeleton/`
- Project ID: `kjbcjkihxskuwwfdqklt`
- Custom domain: `app.captainapp.co.uk`
