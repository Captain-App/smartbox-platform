#!/bin/bash

ADMIN_SECRET="bd2bc65905da06b1dbf4d266f6719997fdebf43727d7382cc9639d475dbf198e"
BASE_URL="https://claw.captainapp.co.uk/api/super"
FLEET_DIR="/Users/crew/openclaw/repos/moltworker/fleet-state"

users=(
  "32c7100e-c6ce-4cf8-8b64-edf4ac3b760b:jack"
  "81bf6a68-28fe-48ef-b257-f9ad013e6298:josh"
  "fe56406b-a723-43cf-9f19-ba2ffcb135b0:miles"
  "38b1ec2b-7a70-4834-a48d-162b8902b0fd:kyla"
  "0f1195c1-6b57-4254-9871-6ef3b7fa360c:rhys"
  "e29fd082-6811-4e29-893e-64699c49e1f0:ben"
  "6d575ef4-7ac8-4a17-b732-e0e690986e58:david-g"
  "aef3677b-afdf-4a7e-bbeb-c596f0d94d29:adnan"
  "5bb7d208-2baf-4c95-8aec-f28e016acedb:david-l"
  "f1647b02-c311-49c3-9c72-48b8fc5da350:joe"
)

timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "=== CONTAINER FLEET CHECK ==="
echo "Timestamp: $timestamp"
echo ""

for entry in "${users[@]}"; do
  user_id="${entry%%:*}"
  name="${entry##*:}"
  
  echo "Checking $name..."
  
  response=$(curl -s -H "X-Admin-Secret: $ADMIN_SECRET" "$BASE_URL/users/$user_id/state/v2" 2>/dev/null)
  
  if [ -z "$response" ] || [ "$response" = "null" ]; then
    echo "  Status: ERROR - No response"
    state="error"
    process_count=0
    healthy="false"
  else
    state=$(echo "$response" | grep -o '"state":"[^"]*"' | head -1 | cut -d'"' -f4)
    process_count=$(echo "$response" | grep -o '"processCount":[0-9]*' | head -1 | cut -d':' -f2)
    healthy=$(echo "$response" | grep -o '"gatewayHealthy":[^,}]*' | head -1 | cut -d':' -f2)
    
    echo "  State: ${state:-unknown}"
    echo "  Processes: ${process_count:-0}"
    echo "  Gateway Healthy: ${healthy:-unknown}"
  fi
  
  # Update state file
  state_file="$FLEET_DIR/$name/state.json"
  if [ -f "$state_file" ]; then
    # Read existing file and update
    tmp_file="${state_file}.tmp"
    jq --arg ts "$timestamp" \
       --arg st "${state:-unknown}" \
       --arg pc "${process_count:-0}" \
       --arg hl "${healthy:-false}" \
       '.checkIns += [{"at":$ts,"state":$st,"processes":($pc|tonumber),"healthy":($hl == "true")}] | .lastCheckIn = {"at":$ts,"state":$st,"processes":($pc|tonumber),"healthy":($hl == "true")}' \
       "$state_file" > "$tmp_file" && mv "$tmp_file" "$state_file"
  fi
  
  echo ""
done

echo "Fleet check complete. State files updated."
