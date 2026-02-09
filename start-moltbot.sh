#!/bin/bash
# Startup script for Moltbot in Cloudflare Sandbox
# v7: Container self-restore via presigned R2 URL
#
# The Worker generates a time-limited, user-scoped presigned URL.
# This script downloads the backup directly from R2 and extracts it.
# No base64 piping, no Worker middleman, no 15s timeout races.

set -e

STARTUP_LOCK="/tmp/moltbot-startup.lock"

# Use flock to prevent concurrent startup attempts
# If another startup is in progress, wait up to 30s then exit
exec 200>"$STARTUP_LOCK"
if ! flock -w 30 200; then
    echo "[$(date -Iseconds)] Another startup is in progress, exiting."
    exit 0
fi

echo "=== Moltbot Startup $(date -Iseconds) ==="
echo "User ID: ${OPENCLAW_USER_ID:-'(not set)'}"

# Check if openclaw gateway is already running - bail early if so
if pgrep -f "openclaw gateway" > /dev/null 2>&1; then
    echo "Moltbot gateway is already running, exiting."
    exit 0
fi

# ============================================================
# SELF-RESTORE FROM R2 (via presigned URL)
# ============================================================
# The Worker passes RESTORE_URL — a presigned S3 URL scoped to this
# user's backup.tar.gz. It expires in 5 minutes and cannot access
# any other user's data.
if [ -n "$RESTORE_URL" ]; then
    echo "Restoring data from R2 (presigned URL)..."
    RESTORE_START=$(date +%s%N)

    # Download and extract in one pipe — no temp files, no base64
    # curl -sf: silent + fail on HTTP errors
    # tar xzf: extract gzipped tar to root
    if curl -sf "$RESTORE_URL" | tar xzf - -C / 2>/dev/null; then
        RESTORE_END=$(date +%s%N)
        RESTORE_MS=$(( (RESTORE_END - RESTORE_START) / 1000000 ))
        echo "Restore complete in ${RESTORE_MS}ms"

        # Write cooldown marker (prevent backup overwriting fresh restore)
        mkdir -p /root/.openclaw
        date +%s > /root/.openclaw/.restore-time
    else
        echo "WARNING: Restore failed or no backup exists — starting fresh"
    fi

    # Clear the URL from env (single-use, about to expire anyway)
    unset RESTORE_URL
else
    echo "No RESTORE_URL — Worker-side restore was used (or no backup exists)"
fi

# Paths
CONFIG_DIR="/root/.openclaw"
CONFIG_FILE="$CONFIG_DIR/openclaw.json"
TEMPLATE_DIR="/root/.openclaw-templates"
TEMPLATE_FILE="$TEMPLATE_DIR/moltbot.json.template"

echo "Config directory: $CONFIG_DIR"

# Create config directory
mkdir -p "$CONFIG_DIR"

# Ensure openclaw docs/templates symlink exists in /workspace/ (sandbox CWD)
# openclaw resolves templates relative to CWD
if [ ! -L "/workspace/docs" ] && [ ! -d "/workspace/docs" ]; then
    mkdir -p /workspace
    ln -sfn /usr/local/lib/node_modules/@captain-app/openclaw/docs /workspace/docs 2>/dev/null || true
fi

# If config file doesn't exist, create from template
if [ ! -f "$CONFIG_FILE" ]; then
    echo "No existing config found, initializing from template..."
    if [ -f "$TEMPLATE_FILE" ]; then
        cp "$TEMPLATE_FILE" "$CONFIG_FILE"
    else
        # Create minimal config if template doesn't exist
        cat > "$CONFIG_FILE" << 'EOFCONFIG'
{
  "agents": {
    "defaults": {
      "workspace": "/root/openclaw"
    }
  },
  "gateway": {
    "port": 18789,
    "mode": "local"
  }
}
EOFCONFIG
    fi
else
    echo "Using existing config"
fi

# ============================================================
# UPDATE CONFIG FROM ENVIRONMENT VARIABLES
# ============================================================
node << EOFNODE
const fs = require('fs');

const configPath = '/root/.openclaw/openclaw.json';
console.log('Updating config at:', configPath);
let config = {};

try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
    console.log('Starting with empty config');
}

// Ensure nested objects exist
config.agents = config.agents || {};
config.agents.defaults = config.agents.defaults || {};
config.agents.defaults.model = config.agents.defaults.model || {};
config.gateway = config.gateway || {};
// NOTE: Do NOT touch config.channels here - channels (Telegram, Discord, etc.)
// are managed by the bot's control UI and restored from R2 backup.

// Gateway configuration
config.gateway.port = 18789;
config.gateway.mode = 'local';
config.gateway.trustedProxies = ['10.1.0.0'];

// Set gateway token if provided - use token-only auth mode (no device pairing required)
if (process.env.OPENCLAW_GATEWAY_TOKEN) {
    config.gateway.auth = config.gateway.auth || {};
    config.gateway.auth.mode = 'token';  // Token-only auth, skip device pairing
    config.gateway.auth.token = process.env.OPENCLAW_GATEWAY_TOKEN;
}

// Allow insecure auth - we're behind Cloudflare proxy (HTTPS to users, HTTP internally)
// This is safe because the external connection is secure, the gateway just can't see it
config.gateway.controlUi = config.gateway.controlUi || {};
config.gateway.controlUi.allowInsecureAuth = true;

// Channel configuration (Telegram, Discord, Slack) is managed by the bot itself
// via the control UI and persisted to R2. We don't override it here.

// Base URL override (e.g., for Cloudflare AI Gateway)
// Usage: Set AI_GATEWAY_BASE_URL or ANTHROPIC_BASE_URL to your endpoint like:
//   https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/anthropic
//   https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/openai
const baseUrl = (process.env.AI_GATEWAY_BASE_URL || process.env.ANTHROPIC_BASE_URL || '').replace(/\/+$/, '');
const isOpenAI = baseUrl.endsWith('/openai');

if (isOpenAI) {
    // Create custom openai provider config with baseUrl override
    // Omit apiKey so moltbot falls back to OPENAI_API_KEY env var
    console.log('Configuring OpenAI provider with base URL:', baseUrl);
    config.models = config.models || {};
    config.models.providers = config.models.providers || {};
    config.models.providers.openai = {
        baseUrl: baseUrl,
        api: 'openai-responses',
        models: [
            { id: 'gpt-5.2', name: 'GPT-5.2', contextWindow: 200000 },
            { id: 'gpt-5', name: 'GPT-5', contextWindow: 200000 },
            { id: 'gpt-4.5-preview', name: 'GPT-4.5 Preview', contextWindow: 128000 },
        ]
    };
    // Add models to the allowlist so they appear in /models
    config.agents.defaults.models = config.agents.defaults.models || {};
    config.agents.defaults.models['openai/gpt-5.2'] = { alias: 'GPT-5.2' };
    config.agents.defaults.models['openai/gpt-5'] = { alias: 'GPT-5' };
    config.agents.defaults.models['openai/gpt-4.5-preview'] = { alias: 'GPT-4.5' };
    config.agents.defaults.model.primary = 'openai/gpt-5.2';
} else if (baseUrl) {
    console.log('Configuring Anthropic provider with base URL:', baseUrl);
    config.models = config.models || {};
    config.models.providers = config.models.providers || {};
    const providerConfig = {
        baseUrl: baseUrl,
        api: 'anthropic-messages',
        models: [
            { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5', contextWindow: 200000 },
            { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', contextWindow: 200000 },
            { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', contextWindow: 200000 },
        ]
    };
    // Include API key in provider config if set (required when using custom baseUrl)
    if (process.env.ANTHROPIC_API_KEY) {
        providerConfig.apiKey = process.env.ANTHROPIC_API_KEY;
    }
    config.models.providers.anthropic = providerConfig;
    // Add models to the allowlist so they appear in /models
    config.agents.defaults.models = config.agents.defaults.models || {};
    config.agents.defaults.models['anthropic/claude-opus-4-5-20251101'] = { alias: 'Opus 4.5' };
    config.agents.defaults.models['anthropic/claude-sonnet-4-5-20250929'] = { alias: 'Sonnet 4.5' };
    config.agents.defaults.models['anthropic/claude-haiku-4-5-20251001'] = { alias: 'Haiku 4.5' };
    config.agents.defaults.model.primary = 'anthropic/claude-opus-4-5-20251101';
} else if (!config.agents.defaults.model.primary) {
    // Default to Anthropic without custom base URL (uses built-in pi-ai catalog)
    // Only set if no model was already configured (e.g., from R2 restore)
    config.agents.defaults.model.primary = 'anthropic/claude-opus-4-5';
}

// Write updated config
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('Configuration updated successfully');
console.log('Channels configured:', Object.keys(config.channels || {}).join(', ') || 'none');
EOFNODE

# ============================================================
# CREATE AUTH PROFILES FOR CUSTOM PROVIDERS
# ============================================================
# The agent dir auth-profiles.json is where openclaw resolves API keys at runtime.
# Without this, models resolve but API calls fail with "No API key found".
AGENT_DIR="/root/.openclaw/agents/main/agent"
mkdir -p "$AGENT_DIR"

if [ -n "$CAPTAINAPP_API_KEY" ]; then
    echo "Creating auth profile for CaptainApp provider..."
    node -e "
const fs = require('fs');
const authPath = '$AGENT_DIR/auth-profiles.json';
let data = { version: 1, profiles: {} };
try { data = JSON.parse(fs.readFileSync(authPath, 'utf8')); } catch {}
data.profiles = data.profiles || {};
data.profiles['captainapp-default'] = {
    provider: 'captainapp',
    type: 'api_key',
    key: process.env.CAPTAINAPP_API_KEY
};
fs.writeFileSync(authPath, JSON.stringify(data));
console.log('Auth profile written to', authPath);
"
fi

# ============================================================
# SHUTDOWN HANDLER
# ============================================================
# The Worker handles backup to R2 via tar-backup.ts before container restart.
# This handler just gives the gateway a moment to finish in-flight requests.

shutdown_handler() {
    echo "[shutdown] Received shutdown signal at $(date -Iseconds)"
    sleep 2
    exit 0
}

# Register signal handlers
trap shutdown_handler SIGTERM SIGINT

# ============================================================
# START GATEWAY
# ============================================================
echo "Starting Moltbot Gateway..."
echo "Gateway will be available on port 18789"

# Clean up stale lock files
rm -f /tmp/openclaw-gateway.lock 2>/dev/null || true
rm -f "$CONFIG_DIR/gateway.lock" 2>/dev/null || true

BIND_MODE="lan"
echo "Dev mode: ${OPENCLAW_DEV_MODE:-false}, Bind mode: $BIND_MODE"

if [ -n "$OPENCLAW_GATEWAY_TOKEN" ]; then
    echo "Starting gateway with token auth..."
    exec openclaw gateway --port 18789 --verbose --allow-unconfigured --bind "$BIND_MODE" --token "$OPENCLAW_GATEWAY_TOKEN"
else
    echo "Starting gateway with device pairing (no token)..."
    exec openclaw gateway --port 18789 --verbose --allow-unconfigured --bind "$BIND_MODE"
fi
