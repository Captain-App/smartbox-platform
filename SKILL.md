# Moltworker Admin API

This directory contains the Moltworker Admin API implementation for managing user containers.

## Implementation Status

### Phase 1: Native File Operations ✅
- `GET /api/super/users/:id/files/*` - Read file using native SDK
- `PUT /api/super/users/:id/files/*` - Write file using native SDK
- `DELETE /api/super/users/:id/files/*` - Delete file
- `GET /api/super/users/:id/files` - List files in directory
- `HEAD /api/super/users/:id/files/*/exists` - Check file exists

### Phase 2: State-Aware API ✅
- `GET /api/super/users/:id/state` - Get container state
- `POST /api/super/users/:id/wake` - Wake up container
- `POST /api/super/users/:id/exec` - Execute command with auto-wake
- Auto-wake middleware wraps file operations

### Phase 3: R2 Dropbox Pattern ✅
- `GET /api/super/users/:id/config` - Get config from R2 (R2-first)
- `PUT /api/super/users/:id/config` - Update config in R2 with versioning
- `GET /api/super/users/:id/config/history` - Get config version history
- `POST /api/super/users/:id/config/rollback` - Rollback to previous version
- `POST /api/super/users/:id/config/reload` - Trigger container reload

## API Endpoints

### Container State Management

```bash
# Get container state
GET /api/super/users/:id/state

# Response
{
  "userId": "uuid",
  "state": "active|idle|sleeping|stopped|error",
  "lastActivity": "2026-02-03T10:30:00Z",
  "processCount": 30,
  "memoryMB": 256,
  "uptimeSeconds": 3600,
  "version": "1.2.3",
  "timestamp": "2026-02-03T10:30:00Z"
}

# Wake up container
POST /api/super/users/:id/wake

# Response
{
  "userId": "uuid",
  "previousState": "sleeping",
  "currentState": "active",
  "action": "started",
  "message": "Container is now active",
  "waitedMs": 5000
}
```

### File Operations

```bash
# Read file
GET /api/super/users/:id/files/path/to/file.txt

# Response
{
  "userId": "uuid",
  "path": "path/to/file.txt",
  "content": "file contents...",
  "encoding": "utf-8",
  "size": 1234,
  "mimeType": "text/plain",
  "timestamp": "2026-02-03T10:30:00Z"
}

# Write file
PUT /api/super/users/:id/files/path/to/file.txt
Content-Type: application/json

{
  "content": "file contents..."
}

# Response
{
  "userId": "uuid",
  "path": "path/to/file.txt",
  "success": true,
  "bytesWritten": 1234,
  "timestamp": "2026-02-03T10:30:00Z"
}

# List files
GET /api/super/users/:id/files?path=/some/dir&recursive=false

# Response
{
  "userId": "uuid",
  "path": "/some/dir",
  "files": [
    {
      "name": "file.txt",
      "absolutePath": "/some/dir/file.txt",
      "relativePath": "file.txt",
      "type": "file",
      "size": 1234,
      "modifiedAt": "2026-02-03T10:30:00Z",
      "mode": "644",
      "permissions": { "readable": true, "writable": true, "executable": false }
    }
  ],
  "count": 1,
  "timestamp": "2026-02-03T10:30:00Z"
}
```

### Config Management (R2-First)

```bash
# Get config from R2
GET /api/super/users/:id/config

# Update config (with automatic versioning)
PUT /api/super/users/:id/config
Content-Type: application/json

{
  "channels": { "telegram": { ... } },
  ...
}

# Get config history
GET /api/super/users/:id/config/history

# Rollback to previous version
POST /api/super/users/:id/config/rollback
{
  "version": 1  # 1 = most recent backup, 2 = second most recent, etc.
}

# Trigger container reload
POST /api/super/users/:id/config/reload
```

## CLI Usage

```bash
# Get container state
./moltworker-admin.sh state miles

# Wake up container
./moltworker-admin.sh wake miles

# Read file
./moltworker-admin.sh files get miles workspace/plan.md

# Write file (with auto-wake)
./moltworker-admin.sh files put miles /local/path.json remote/path.json

# Execute command (with auto-wake)
./moltworker-admin.sh exec miles 'echo test'
```

## Authentication

All super admin endpoints require the `X-Admin-Secret` header with the gateway master token:

```bash
X-Admin-Secret: your-gateway-master-token
```

## Auto-Wake Behavior

The API automatically wakes sleeping containers before operations:
- File operations (read, write, delete, list)
- Command execution
- Config operations

This ensures reliable access without manual intervention.
