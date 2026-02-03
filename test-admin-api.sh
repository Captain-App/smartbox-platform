#!/bin/bash
# Test script for Moltworker Admin API
# Usage: ./test-admin-api.sh <user>

set -e

USER="${1:-miles}"
TOKEN_FILE="/Users/crew/clawd/secrets/moltbot-gateway-token.txt"
TOKEN="$(cat "$TOKEN_FILE" 2>/dev/null || echo "")"
BASE_URL="https://claw.captainapp.co.uk"

if [ -z "$TOKEN" ]; then
  echo "Error: Could not read token from $TOKEN_FILE"
  exit 1
fi

echo "=== Testing Moltworker Admin API ==="
echo "User: $USER"
echo "URL: $BASE_URL"
echo ""

# Resolve user ID
echo "1. Resolving user ID..."
USER_LOOKUP="/Users/crew/clawd/life/areas/projects/moltbot/user-lookup.json"
USER_ID="$(jq -r --arg u "$USER" '.knownUsers[$u].id // empty' "$USER_LOOKUP" 2>/dev/null)"
if [ -z "$USER_ID" ]; then
  echo "   User not found in lookup, trying as UUID..."
  USER_ID="$USER"
fi
echo "   User ID: $USER_ID"
echo ""

# Test state endpoint
echo "2. Testing state endpoint..."
STATE_RESPONSE=$(curl -s -H "X-Admin-Secret: $TOKEN" "$BASE_URL/api/super/users/$USER_ID/state" || echo '{"error":"request failed"}')
echo "   Response: $(echo "$STATE_RESPONSE" | jq -c . 2>/dev/null || echo "$STATE_RESPONSE")"
echo ""

# Test wake endpoint (only if sleeping or stopped)
CURRENT_STATE=$(echo "$STATE_RESPONSE" | jq -r '.state // "unknown"')
if [ "$CURRENT_STATE" = "sleeping" ] || [ "$CURRENT_STATE" = "stopped" ] || [ "$CURRENT_STATE" = "error" ]; then
  echo "3. Testing wake endpoint..."
  WAKE_RESPONSE=$(curl -s -X POST -H "X-Admin-Secret: $TOKEN" "$BASE_URL/api/super/users/$USER_ID/wake" || echo '{"error":"request failed"}')
  echo "   Response: $(echo "$WAKE_RESPONSE" | jq -c . 2>/dev/null || echo "$WAKE_RESPONSE")"
  echo ""
  
  # Wait a moment and check state again
  echo "4. Checking state after wake..."
  sleep 5
  STATE_RESPONSE=$(curl -s -H "X-Admin-Secret: $TOKEN" "$BASE_URL/api/super/users/$USER_ID/state" || echo '{"error":"request failed"}')
  echo "   Response: $(echo "$STATE_RESPONSE" | jq -c . 2>/dev/null || echo "$STATE_RESPONSE")"
  echo ""
else
  echo "3. Skipping wake test (container is $CURRENT_STATE)"
  echo ""
fi

# Test file write
echo "5. Testing file write..."
TEST_CONTENT="Test content from admin API"
WRITE_RESPONSE=$(curl -s -X PUT \
  -H "X-Admin-Secret: $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"content\":\"$TEST_CONTENT\"}" \
  "$BASE_URL/api/super/users/$USER_ID/files/tmp/test-file.txt" || echo '{"error":"request failed"}')
echo "   Response: $(echo "$WRITE_RESPONSE" | jq -c . 2>/dev/null || echo "$WRITE_RESPONSE")"
echo ""

# Test file read
echo "6. Testing file read..."
READ_RESPONSE=$(curl -s -H "X-Admin-Secret: $TOKEN" "$BASE_URL/api/super/users/$USER_ID/files/tmp/test-file.txt" || echo '{"error":"request failed"}')
echo "   Response: $(echo "$READ_RESPONSE" | jq -c . 2>/dev/null || echo "$READ_RESPONSE")"
echo ""

# Verify content
echo "7. Verifying content..."
READ_CONTENT=$(echo "$READ_RESPONSE" | jq -r '.content // empty')
if [ "$READ_CONTENT" = "$TEST_CONTENT" ]; then
  echo "   ✓ Content matches!"
else
  echo "   ✗ Content mismatch: expected '$TEST_CONTENT', got '$READ_CONTENT'"
fi
echo ""

# Test file list
echo "8. Testing file list..."
LIST_RESPONSE=$(curl -s -H "X-Admin-Secret: $TOKEN" "$BASE_URL/api/super/users/$USER_ID/files?path=/tmp" || echo '{"error":"request failed"}')
echo "   Found $(echo "$LIST_RESPONSE" | jq '.count // 0') files in /tmp"
echo ""

# Test file delete
echo "9. Testing file delete..."
DELETE_RESPONSE=$(curl -s -X DELETE -H "X-Admin-Secret: $TOKEN" "$BASE_URL/api/super/users/$USER_ID/files/tmp/test-file.txt" || echo '{"error":"request failed"}')
echo "   Response: $(echo "$DELETE_RESPONSE" | jq -c . 2>/dev/null || echo "$DELETE_RESPONSE")"
echo ""

# Test config endpoint
echo "10. Testing config endpoint..."
CONFIG_RESPONSE=$(curl -s -H "X-Admin-Secret: $TOKEN" "$BASE_URL/api/super/users/$USER_ID/config" || echo '{"error":"request failed"}')
echo "   Response: $(echo "$CONFIG_RESPONSE" | jq -c . 2>/dev/null || echo "$CONFIG_RESPONSE")"
echo ""

echo "=== Test Complete ==="
