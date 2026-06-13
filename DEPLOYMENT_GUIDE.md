# Gobi Replica v2 — Deployment Guide

## What's New in v2

| Feature | v1 | v2 |
|---------|----|----|
| **LLM** | OpenAI only (paid) | OpenRouter free tier → Ollama local → OpenAI fallback |
| **SMS** | Not available | Twilio SMS gateway with webhook |
| **Memory** | Basic conversation storage | Semantic search, FTS5 keyword search, auto-summarization |
| **Dependencies** | 10 packages (openai, playwright, cheerio) | 6 packages — zero proprietary, zero telemetry |
| **License Freedom** | OpenAI SDK + Playwright (telemetry risk) | 100% MIT/Apache-2.0, no vendor tracking |

---

## Fly.io Free Tier Deployment

### Prerequisites
- [Fly CLI installed](https://fly.io/docs/hands-on/install-flyctl/)
- [Fly.io account](https://fly.io/signup) (Free Tier: 3× 256MB VMs, 3GB storage, 160GB outbound)
- [OpenRouter API key](https://openrouter.ai/keys) (free — for free-tier LLM models)
- Optional: Twilio account for SMS, Ollama for local LLM

### Quick Deploy (5 minutes)

```bash
# 1. Navigate to the project
cd gobi-replica

# 2. Launch on Fly.io (free tier)
fly launch --name your-agent-name --region iad --no-deploy

# 3. Set your secrets
# OpenRouter (free tier — primary LLM)
fly secrets set OPENROUTER_API_KEY=sk-or-v1-your-key-here

# OpenAI (paid fallback — optional)
fly secrets set OPENAI_API_KEY=sk-your-key-here

# Session security
fly secrets set SESSION_SECRET=$(openssl rand -hex 32)

# 4. Create persistent volume (3GB free)
fly volumes create data --region iad --size 1

# 5. Deploy!
fly deploy

# 6. Open your agent
fly open
```

### LLM Provider Setup

The agent tries providers in priority order. Configure via `LLM_PROVIDERS` env:

**1. OpenRouter (free tier — recommended)**
```bash
fly secrets set OPENROUTER_API_KEY=sk-or-v1-xxxxxxxxxxxxx
```
Free models: `meta-llama/llama-3.2-3b-instruct:free`, `google/gemma-2-9b-it:free`
No credit card needed. Rate-limited but zero cost.

**2. Ollama (local — fully offline)**
```bash
# Run on your local machine or a sidecar VM
ollama pull llama3.2:3b
# Set the URL in fly.toml env or secrets
fly secrets set OLLAMA_BASE_URL=http://your-ollama-host:11434/v1
```

**3. OpenAI (paid fallback)**
```bash
fly secrets set OPENAI_API_KEY=sk-xxxxxxxxxxxxx
fly secrets set OPENAI_MODEL=gpt-4o-mini
```

### Twilio SMS Gateway

```bash
# Enable SMS
fly secrets set SMS_ENABLED=true
fly secrets set TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxx
fly secrets set TWILIO_AUTH_TOKEN=your-auth-token
fly secrets set TWILIO_FROM_NUMBER=+1234567890
```

Configure your Twilio phone number's webhook to point to:
`https://your-app.fly.dev/api/sms/webhook`

### Email (SMTP)

```bash
fly secrets set SMTP_HOST=smtp.gmail.com
fly secrets set SMTP_PORT=587
fly secrets set SMTP_USER=you@gmail.com
fly secrets set SMTP_PASS=your-app-password
fly secrets set EMAIL_FROM=agent@yourdomain.com
```

---

## Architecture v2

```
┌──────────────────────────────────────────────────────────┐
│           Fly.io Free Tier VM (shared-cpu-1x, 256MB)     │
│                                                          │
│  ┌─────────────┐  ┌──────────────────────────────────┐  │
│  │ Express Web   │  │       Agent Engine v2           │  │
│  │ Server :8080  │  │  ┌──────────────────────────┐  │  │
│  │              │  │  │  Multi-Provider LLM       │  │  │
│  │ • Chat API   │  │  │  OpenRouter → Ollama →    │  │  │
│  │ • SMS Webhook│  │  │  OpenAI (auto-failover)   │  │  │
│  │ • Memory API │  │  └──────────────────────────┘  │  │
│  │ • Tool API   │  │  ┌──────────────────────────┐  │  │
│  └──────┬──────┘  │  │  Memory Service           │  │  │
│         │         │  │  • Semantic search (cosine)│  │  │
│  ┌──────┴─────────┴──┴──────────────────────────┐  │  │
│  │      SQLite Database (WAL mode)               │  │  │
│  │  conversations, messages, turns, summaries,   │  │  │
│  │  facts, FTS5 index, tool results              │  │  │
│  └───────────────────────────────────────────────┘  │  │
│                                                      │  │
│  ┌──────────────────────────────────────────────────┐ │  │
│  │  17 Tools (all native — zero proprietary deps)   │ │  │
│  │  Search, Scrape, SQL, Files, HTTP, Charts,       │ │  │
│  │  Code Exec, Email, SMS, PDF, Images, Mermaid...  │ │  │
│  └──────────────────────────────────────────────────┘ │  │
└──────────────────────────────────────────────────────┘
```

---

## Project Structure v2

```
gobi-replica/
├── src/
│   ├── index.js              # Entry point (v2 services)
│   ├── config.js             # Multi-provider + SMS + memory config
│   ├── agent/
│   │   └── engine.js         # Core agent loop with memory & SMS
│   ├── tools/
│   │   └── registry.js       # 17 native tool implementations
│   ├── services/
│   │   ├── database.js       # SQLite with WAL mode
│   │   ├── llm.js            # Multi-provider LLM (native fetch)
│   │   ├── memory.js         # Semantic + keyword search + summaries
│   │   ├── sms.js            # Twilio SMS gateway (native fetch)
│   │   ├── email.js          # SMTP outbound
│   │   └── scheduler.js      # Cron-based task scheduling
│   ├── skills/
│   │   └── mermaid/index.js  # Diagram rendering
│   └── web/
│       ├── server.js         # Express API (SMS webhook + memory)
│       └── public/
│           └── index.html    # Chat UI
├── Dockerfile                # Multi-stage Node.js build
├── fly.toml                  # Fly.io free tier config (v2 env)
├── .env.example              # Complete v2 environment template
├── package.json              # 6 dependencies, all MIT/Apache-2.0
├── .gitignore
├── .dockerignore
└── DEPLOYMENT_GUIDE.md       # This file
```

---

## Dependency Audit — Zero Proprietary

All 6 production dependencies are permissively licensed:

| Package | License | Purpose |
|---------|---------|---------|
| express | MIT | Web server |
| better-sqlite3 | MIT | Embedded database |
| node-cron | ISC | Task scheduler |
| nodemailer | MIT-0 | Email outbound |
| dotenv | BSD-2-Clause | Environment config |
| uuid | MIT | Unique IDs |

**Removed from v1:** `openai` (proprietary SDK + telemetry), `playwright` (Chromium dependency + telemetry), `cheerio` (replaced by native fetch + regex). All LLM calls use Node.js native `fetch` — no vendor SDKs, no tracking.

---

## Commands Cheatsheet

```bash
fly deploy                      # Deploy the app
fly open                        # Open in browser
fly logs                        # View logs
fly ssh console                 # SSH into the VM
fly secrets list                # View all secrets
fly secrets set KEY=value       # Set a single secret
fly scale show                  # Check VM specs
fly status                      # App status
fly volumes list                # Persistent volumes
fly destroy                     # Destroy app (caution!)
```

### Local Development

```bash
cp .env.example .env
# Edit .env with your OpenRouter key (free)
npm install
npm run dev
# Open http://localhost:8080
```

---

## Free Tier Limits

- **VMs**: 3 shared-cpu-1x at 256MB each
- **Storage**: 3GB total across volumes
- **Outbound Transfer**: 160GB/month
- **Included**: SSL certs, custom domains, global regions
- **Auto-sleep**: Machines sleep after 5 min idle (wake on request)

---

## Troubleshooting

- **Out of memory**: Ensure `fly.toml` has `memory = "256mb"` minimum
- **LLM fails**: Check provider priority order in `LLM_PROVIDERS`; verify OpenRouter key
- **No OpenRouter key?** Get one free at https://openrouter.ai/keys (no credit card)
- **SMS not working**: Verify `SMS_ENABLED=true` and Twilio credentials
- **Database errors**: Check `fly volumes list` and mount status
- **Health check fails**: Run `fly logs` to check startup errors