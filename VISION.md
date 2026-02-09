# Smartbox Platform Vision

> **Your AI companion in the cloud — always-on, never dies.**

## What is a Smartbox?

A **Smartbox** is your personal AI companion that lives in the cloud. Think of it as a smarter version of your phone's voice assistant, but always available, with persistent memory, and capable of connecting to your digital life.

### The Core Analogy

| Traditional | Smartbox Equivalent |
|-------------|---------------------|
| Your phone | Your Smartbox (cloud-based, always on) |
| Siri/Alexa | PA Smartbox (personal assistant) |
| Apps | Specialized Smartboxes (project, runtime, etc.) |
| iCloud | R2 storage + persistent state |

### Key Characteristics

1. **Always-On** — Runs 24/7 in the cloud, never sleeps (unless configured to)
2. **Persistent Memory** — Remembers conversations, context, and preferences across sessions
3. **Multi-Channel** — Talk to it via Telegram, Discord, Slack, web UI, or CLI
4. **Extensible** — Add specialized capabilities through additional Smartboxes
5. **Yours** — Isolated, secure, and private to you

---

## The Smartbox Platform

The **Smartbox Platform** is a multi-agent system where each user has access to multiple specialized **Smartboxes**, each optimized for a specific use case.

### Platform Philosophy

Instead of one AI trying to do everything, the platform uses **specialized agents**:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Your Smartbox Ecosystem                          │
│                                                                      │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐     │
│  │   PA Smartbox   │  │ Project Smartbox│  │Runtime Smartbox │     │
│  │                 │  │                 │  │                 │     │
│  │ • Conversational│  │ • Code knowledge│  │ • Deployments   │     │
│  │ • Orchestrates  │  │ • Git access    │  │ • Server mgmt   │     │
│  │ • Daily tasks   │  │ • PR reviews    │  │ • Monitoring    │     │
│  │ • Scheduling    │  │ • Architecture  │  │ • Debugging     │     │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘     │
│           │                    │                    │               │
│           └────────────────────┼────────────────────┘               │
│                                │                                    │
│                      ┌─────────▼─────────┐                         │
│                      │  Local Connector  │                         │
│                      │    (Your GSV)     │                         │
│                      └───────────────────┘                         │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Types of Smartboxes

### 1. PA Smartbox (Personal Assistant)

Your main conversational interface — the "face" of your AI ecosystem.

**Responsibilities:**
- Daily conversations and Q&A
- Task management and reminders
- Orchestrating other Smartboxes
- Understanding context and routing requests
- Personal knowledge management

**Characteristics:**
- Always conversational and friendly
- Knows your preferences and history
- Can delegate to specialized Smartboxes
- First point of contact for any request

---

### 2. Project Smartboxes

Specialized agents for specific projects you're working on.

**Responsibilities:**
- Deep knowledge of a specific codebase
- Access to deployment keys and credentials
- Understanding of project architecture
- Code reviews and suggestions
- Documentation assistance

**Example:**
- "Clawdbot Project Smartbox" — knows the Clawdbot codebase, can review PRs, understand deployment flows
- "Website Project Smartbox" — manages your personal website, knows the tech stack

**Characteristics:**
- Scoped to a single project
- Has access to relevant secrets and keys
- Understands project-specific conventions
- Can interact with Git, CI/CD, etc.

---

### 3. Runtime Smartboxes

Infrastructure and operational agents.

**Responsibilities:**
- Server management and monitoring
- Deployment operations
- Log analysis and debugging
- Infrastructure health checks
- Alert handling

**Characteristics:**
- Knows your infrastructure
- Has appropriate SSH/infra credentials
- Monitors and reports on health
- Can respond to and resolve incidents

---

### 4. Customer Service Smartboxes

(For business use cases)

**Responsibilities:**
- Handling customer inquiries
- Access to order/ticket systems
- Following support playbooks
- Escalating when needed

---

### 5. Custom Smartboxes

Any specialized agent you can imagine:
- Research Smartbox (academic paper analysis)
- Finance Smartbox (budget tracking, investments)
- Creative Smartbox (writing, design assistance)
- Social Smartbox (manage social media presence)

---

## The Local Connector (GSV)

The **Local Connector** is the bridge between your local machine and your Smartbox ecosystem.

### What It Is

The Gateway Service (GSV) running on your local machine that:
- Connects **TO** your cloud Smartbox
- Provides secure access to local resources
- Enables bidirectional communication

### Key Point

> **The GSV connects OUT to your Smartbox, not the other way around.**

This is important for security — your Smartbox doesn't need to listen on your local network. Instead, your local GSV maintains an outbound connection to the cloud.

### Capabilities

```
┌─────────────────┐         Cloud          ┌─────────────────┐
│  Your Laptop    │  ═══════════════════►  │  Your Smartbox  │
│                 │    Secure WebSocket    │                 │
│  ┌───────────┐  │                        │  ┌───────────┐  │
│  │ Local GSV │──┘                        │  │  Agents   │  │
│  └─────┬─────┘                           │  └─────┬─────┘  │
│        │                                 │        │        │
│  ┌─────▼─────┐                           │  ┌─────▼─────┐  │
│  │  Local    │                           │  │  Cloud    │  │
│  │ Resources │                           │  │  Services │  │
│  │ • Files   │                           │  │ • APIs    │  │
│  │ • Docker  │                           │  │ • Search  │  │
│  │ • APIs    │                           │  │ • Storage │  │
│  └───────────┘                           │  └───────────┘  │
└─────────────────┘                        └─────────────────┘
```

**Local resources accessible via GSV:**
- File system (with permission)
- Local databases
- Docker instances
- Development servers
- Command execution

---

## Multi-User Scenarios

### Scenario 1: One Smartbox Per User (Default)

Most users start with a single **PA Smartbox** that handles everything.

**Best for:**
- Individual users
- Simple use cases
- Getting started quickly

```
User: Jack
└── PA Smartbox (Jack's Assistant)
    ├── Handles conversations
    ├── Manages calendar
    ├── Answers questions
    └── (Can be extended with specialized Smartboxes later)
```

### Scenario 2: Multiple Specialized Smartboxes

As needs grow, add specialized Smartboxes that the PA orchestrates.

**Best for:**
- Power users
- Multiple active projects
- Complex workflows

```
User: Jack (Power User)
│
├── PA Smartbox (Jack's Assistant)
│   └── Orchestrates other Smartboxes
│
├── Project Smartbox: Clawdbot
│   ├── Codebase knowledge
│   ├── Deployment keys
│   └── PR reviews
│
├── Project Smartbox: Personal Website
│   ├── Jekyll site management
│   └── Content updates
│
└── Runtime Smartbox: Infrastructure
    ├── Server monitoring
    ├── Log analysis
    └── Alert handling
```

### Scenario 3: Team Shared Smartboxes

(Future concept) Smartboxes can be shared across team members with appropriate permissions.

```
Team: Engineering
│
├── Shared: Project Smartbox (Monorepo)
│   ├── Accessible by all engineers
│   ├── Code knowledge
│   └── Deployment access
│
├── Shared: Runtime Smartbox (Production)
│   ├── On-call team access
│   ├── Incident response
│   └── Runbooks
│
└── Individual PA Smartboxes
    ├── Personal to each team member
    └── Can interact with shared Smartboxes
```

---

## Inter-Smartbox Communication

### Current State

Each Smartbox is independent. The **PA Smartbox** acts as the orchestrator, deciding which specialized Smartbox to invoke for a given request.

### Future Vision: Smartbox Mesh

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Smartbox Mesh                                  │
│                                                                      │
│   ┌─────────────┐      messaging       ┌─────────────┐             │
│   │ PA Smartbox │◄────────────────────►│Project Smart│             │
│   │   (User)    │      protocol        │    (Code)   │             │
│   └──────┬──────┘                      └─────────────┘             │
│          │                                                          │
│          │         ┌─────────────┐                                 │
│          └────────►│Runtime Smart│                                 │
│                    │  (Infra)    │                                 │
│                    └─────────────┘                                 │
│                                                                      │
│   Capabilities:                                                      │
│   • Smartboxes can message each other                              │
│   • Async task delegation                                           │
│   • Shared context and memory                                       │
│   • Collaborative problem-solving                                   │
└─────────────────────────────────────────────────────────────────────┘
```

**Use Cases:**
- PA delegates a deployment task to Runtime Smartbox
- Project Smartbox asks Runtime Smartbox for logs
- Async operations with notification back to PA

---

## Platform Architecture

### High-Level Components

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Smartbox Platform                              │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                    Cloudflare Edge                            │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐   │  │
│  │  │Edge Router  │  │  Admin API  │  │  Container Gateway  │   │  │
│  │  │             │  │             │  │                     │   │  │
│  │  │ • Routing   │  │ • Fleet mgmt│  │ • Per-user proxy    │   │  │
│  │  │ • Auth      │  │ • Config    │  │ • WebSockets        │   │  │
│  │  │ • Rate limit│  │ • Exec API  │  │ • Container lifecycle│   │  │
│  │  └──────┬──────┘  └─────────────┘  └──────────┬──────────┘   │  │
│  │         │                                     │               │  │
│  │         └─────────────────────────────────────┘               │  │
│  │                           │                                   │  │
│  │                   ┌───────▼────────┐                          │  │
│  │                   │  Sandbox DOs   │                          │  │
│  │                   │                │                          │  │
│  │                   │ • Smartbox 1   │                          │  │
│  │                   │ • Smartbox 2   │                          │  │
│  │                   │ • Smartbox N   │                          │  │
│  │                   └────────────────┘                          │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                           │                                         │
│                   ┌───────▼────────┐                                │
│                   │  R2 Storage    │  (Persistent backup)           │
│                   └────────────────┘                                │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Design Principles

1. **Isolation** — Each Smartbox runs in its own container
2. **Persistence** — R2 storage for state backup/restore
3. **Scalability** — Tiered resources (standard-1/2/3)
4. **Security** — JWT auth, device pairing, encrypted connections
5. **Extensibility** — Plugin architecture for new Smartbox types

---

## User Journey

### Getting Started (New User)

1. **Sign up** — Create account on CaptainApp
2. **Deploy** — One-click deploy your PA Smartbox
3. **Connect** — Pair your devices (Telegram, browser, etc.)
4. **Converse** — Start chatting with your PA Smartbox
5. **Extend** — Add specialized Smartboxes as needed

### Power User Flow

1. **PA Smartbox** handles daily tasks
2. **Project Smartbox** added for active project
3. **Local Connector** installed for local access
4. **Runtime Smartbox** monitors infrastructure
5. **Inter-Smartbox messaging** enables complex workflows

---

## Summary

| Concept | Description |
|---------|-------------|
| **Smartbox** | Your cloud AI companion, always-on, never dies |
| **Smartbox Platform** | Multi-agent system with specialized agents |
| **PA Smartbox** | Personal assistant, conversational, orchestrates others |
| **Project Smartbox** | Specialized per project (code, deployments) |
| **Runtime Smartbox** | Infrastructure and operations management |
| **Local Connector** | GSV on your machine connecting TO your Smartbox |
| **Smartbox Mesh** | Future inter-Smartbox communication |

---

*The Smartbox Platform is the future of personal AI — not one assistant trying to do everything, but a team of specialized agents working together for you.*
