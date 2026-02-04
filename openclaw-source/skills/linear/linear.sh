#!/bin/bash
# Linear CLI wrapper with merphy.ai integration

LINEAR_API_KEY="${LINEAR_API_KEY:-}"
LINEAR_API_URL="https://api.linear.app/graphql"

if [ -z "$LINEAR_API_KEY" ]; then
  echo "Error: LINEAR_API_KEY not set"
  echo "Get your API key from: https://linear.app/settings/api"
  exit 1
fi

cmd="$1"
shift

case "$cmd" in
  issue)
    subcmd="$1"
    shift
    case "$subcmd" in
      create)
        title=""
        description=""
        priority="2"
        team_id="${LINEAR_TEAM_ID:-}"
        parent_id=""
        project_id=""
        
        while [[ $# -gt 0 ]]; do
          case "$1" in
            --title) title="$2"; shift 2 ;;
            --description) description="$2"; shift 2 ;;
            --priority) priority="$2"; shift 2 ;;
            --team) team_id="$2"; shift 2 ;;
            --parent) parent_id="$2"; shift 2 ;;
            --project) project_id="$2"; shift 2 ;;
            *) shift ;;
          esac
        done
        
        if [ -z "$title" ]; then
          echo "Error: --title required"
          exit 1
        fi
        
        # Map priority string to number
        case "$priority" in
          urgent) priority_num=0 ;;
          high) priority_num=1 ;;
          normal) priority_num=2 ;;
          low) priority_num=3 ;;
          *) priority_num="$priority" ;;
        esac
        
        # Build input JSON
        input="{ title: \"$title\", description: \"$description\", priority: $priority_num"
        if [ -n "$team_id" ]; then
          input="$input, teamId: \"$team_id\""
        fi
        if [ -n "$parent_id" ]; then
          # Resolve parent identifier to ID
          parent_uuid=$(curl -s -X POST "$LINEAR_API_URL" \
            -H "Authorization: $LINEAR_API_KEY" \
            -H "Content-Type: application/json" \
            -d "{\"query\": \"query { issues(filter: { identifier: { eq: \\"$parent_id\\" } }) { nodes { id } } }\"}" | jq -r '.data.issues.nodes[0].id')
          if [ "$parent_uuid" != "null" ] && [ -n "$parent_uuid" ]; then
            input="$input, parentId: \"$parent_uuid\""
          fi
        fi
        if [ -n "$project_id" ]; then
          input="$input, projectId: \"$project_id\""
        fi
        input="$input }"
        
        query="mutation { issueCreate(input: $input) { issue { id identifier title url project { name } } } }"
        
        curl -s -X POST "$LINEAR_API_URL" \
          -H "Authorization: $LINEAR_API_KEY" \
          -H "Content-Type: application/json" \
          -d "{\"query\": \"$query\"}" | jq -r '.data.issueCreate.issue // .errors'
        ;;
        
      list|ls)
        query='query Issues { issues(first: 10) { nodes { id identifier title state { name } priority project { name } parent { identifier } } } }'
        curl -s -X POST "$LINEAR_API_URL" \
          -H "Authorization: $LINEAR_API_KEY" \
          -H "Content-Type: application/json" \
          -d "{\"query\": \"$query\"}" | jq -r '.data.issues.nodes[] | "\(.identifier): \(.title) [\(.state.name)] (P\(.priority)) Proj:\(.project.name // "-") Parent:\(.parent.identifier // "-")"'
        ;;
        
      link-project)
        issue_id="$1"
        project_id="$2"
        
        if [ -z "$issue_id" ] || [ -z "$project_id" ]; then
          echo "Usage: linear issue link-project ISS-123 project-uuid"
          exit 1
        fi
        
        # Resolve issue identifier to UUID
        issue_uuid=$(curl -s -X POST "$LINEAR_API_URL" \
          -H "Authorization: $LINEAR_API_KEY" \
          -H "Content-Type: application/json" \
          -d "{\"query\": \"query { issues(filter: { identifier: { eq: \\"$issue_id\\" } }) { nodes { id } } }\"}" | jq -r '.data.issues.nodes[0].id')
        
        query="mutation { issueUpdate(id: \"$issue_uuid\", input: { projectId: \"$project_id\" }) { issue { id identifier project { name } } } }"
        
        curl -s -X POST "$LINEAR_API_URL" \
          -H "Authorization: $LINEAR_API_KEY" \
          -H "Content-Type: application/json" \
          -d "{\"query\": \"$query\"}" | jq -r '.data.issueUpdate.issue // .errors'
        ;;
        
      *)
        echo "Usage: linear issue {create|list|link-project}"
        exit 1
        ;;
    esac
    ;;
    
  requirement|project)
    subcmd="$1"
    shift
    case "$subcmd" in
      create)
        name=""
        description=""
        team_ids="${LINEAR_TEAM_ID:-}"
        
        while [[ $# -gt 0 ]]; do
          case "$1" in
            --name) name="$2"; shift 2 ;;
            --description) description="$2"; shift 2 ;;
            --team) team_ids="$2"; shift 2 ;;
            *) shift ;;
          esac
        done
        
        if [ -z "$name" ]; then
          echo "Error: --name required"
          exit 1
        fi
        
        # Build team IDs array
        teams_json="["
        IFS=',' read -ra teams <<< "$team_ids"
        for i in "${!teams[@]}"; do
          if [ $i -gt 0 ]; then teams_json="$teams_json,"; fi
          teams_json="$teams_json\"${teams[$i]}\""
        done
        teams_json="$teams_json]"
        
        query="mutation { projectCreate(input: { name: \"$name\", description: \"$description\", teamIds: $teams_json }) { project { id name url } } }"
        
        curl -s -X POST "$LINEAR_API_URL" \
          -H "Authorization: $LINEAR_API_KEY" \
          -H "Content-Type: application/json" \
          -d "{\"query\": \"$query\"}" | jq -r '.data.projectCreate.project // .errors'
        ;;
        
      list|ls)
        query='query Projects { projects(first: 10) { nodes { id name description state teamIds } } }'
        curl -s -X POST "$LINEAR_API_URL" \
          -H "Authorization: $LINEAR_API_KEY" \
          -H "Content-Type: application/json" \
          -d "{\"query\": \"$query\"}" | jq -r '.data.projects.nodes[] | "\(.id): \(.name) [\(.state)]"'
        ;;
        
      *)
        echo "Usage: linear project {create|list}"
        exit 1
        ;;
    esac
    ;;
    
  teams)
    query='query Teams { teams { nodes { id name key } } }'
    curl -s -X POST "$LINEAR_API_URL" \
      -H "Authorization: $LINEAR_API_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"query\": \"$query\"}" | jq -r '.data.teams.nodes[] | "\(.key): \(.name) (\(.id))"'
    ;;
    
  *)
    echo "Linear CLI with merphy.ai integration"
    echo ""
    echo "Usage:"
    echo "  linear issue create --title \"Title\" --description \"Desc\" --priority high"
    echo "  linear issue create --title \"Sub-task\" --parent \"CAP-123\""
    echo "  linear issue create --title \"Task\" --project \"project-uuid\""
    echo "  linear issue list"
    echo "  linear issue link-project ISS-123 project-uuid"
    echo "  linear project create --name \"Requirement\" --description \"Details\""
    echo "  linear teams"
    echo ""
    echo "merphy.ai Integration:"
    echo "  - Requirements → Linear Projects"
    echo "  - Issues → Linear Issues with --parent or --project"
    echo ""
    echo "Environment:"
    echo "  LINEAR_API_KEY - Required. Get from https://linear.app/settings/api"
    exit 1
    ;;
esac
