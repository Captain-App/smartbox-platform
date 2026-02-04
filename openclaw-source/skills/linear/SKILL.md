# Linear Skill

Create and manage issues in Linear via the GraphQL API. Supports parent/child relationships and requirement linking for merphy.ai integration.

## Authentication

Set `LINEAR_API_KEY` in your environment. Get it from: https://linear.app/settings/api

## Usage

### Create Issue
```bash
linear issue create --title "Bug: Login broken" --description "Users can't log in" --priority high
```

### Create Issue with Parent
```bash
linear issue create --title "Sub-task" --description "Details" --parent "CAP-123"
```

### Create Requirement (merphy.ai)
```bash
linear requirement create --title "Build user auth" --description "Full auth system" --team "Engineering"
```

### Link Issue to Requirement
```bash
linear issue link-requirement ISS-456 REQ-789
```

### List Issues
```bash
linear issues --team "Engineering" --state "In Progress"
```

### Update Issue
```bash
linear issue update ISS-123 --state "Done"
```

## API

Base URL: `https://api.linear.app/graphql`

Headers:
- `Authorization: $LINEAR_API_KEY`
- `Content-Type: application/json`

## Common Mutations

```graphql
# Create issue
mutation IssueCreate {
  issueCreate(input: {
    title: "Title here",
    description: "Description here",
    teamId: "team-uuid",
    priority: 1  # 0=urgent, 1=high, 2=normal, 3=low
  }) {
    issue { id title url }
  }
}

# Create issue with parent
mutation IssueCreateWithParent {
  issueCreate(input: {
    title: "Sub-task",
    description: "Details",
    teamId: "team-uuid",
    parentId: "parent-issue-uuid"
  }) {
    issue { id identifier title url }
  }
}

# Create project (requirement)
mutation ProjectCreate {
  projectCreate(input: {
    name: "Project Name",
    description: "Description",
    teamIds: ["team-uuid"]
  }) {
    project { id name url }
  }
}

# Link issue to project
mutation IssueUpdateProject {
  issueUpdate(
    id: "issue-uuid",
    input: { projectId: "project-uuid" }
  ) {
    issue { id identifier project { name } }
  }
}
```

## Environment Variables

- `LINEAR_API_KEY` - Required. Your Linear API key.
- `LINEAR_TEAM_ID` - Optional. Default team ID.

## merphy.ai Integration

Every Linear issue should link to a requirement (project) or parent issue:

1. **Requirements** → Linear Projects
2. **Issues** → Linear Issues with `parentId` or `projectId`
3. **PERT tasks** → Linear Issues with dependencies tracked via relationships

This creates a hierarchy: Project → Parent Issue → Child Issues
