# Gobi Replica

**A local-first autonomous AI agent built to do real work.**

Gobi Replica is a self-hostable agent runtime with multi-provider LLM support, persistent SQLite memory, tool execution, scheduled tasks, and web/API access. It is designed around a simple principle: **give the agent useful tools, persistent context, and a runtime you control.**

## What it does

- 🧠 **Local AI** — Ollama support for private, local inference
- 🔌 **Multi-provider LLMs** — Ollama, OpenRouter, and OpenAI
- 🛠️ **Tool execution** — agent-driven shell, data, web, file, and automation workflows
- 🧠 **Persistent memory** — semantic + keyword context and long-term facts
- 💾 **SQLite persistence** — conversations, messages, plans, and agent state
- ⏰ **Scheduling** — cron-based autonomous tasks
- 📱 **Communication** — email and SMS integrations
- 🌐 **Web interface** — browser dashboard and HTTP API on port `8080`
- 🐳 **Container-ready** — Docker + Railpack builds

## Architecture

```text
                         ┌─────────────────────┐
                         │      Gobi Replica    │
                         │     Agent Engine     │
                         └──────────┬──────────┘
                                    │
             ┌──────────────────────┼──────────────────────┐
             │                      │                      │
        ┌────▼────┐            ┌────▼────┐            ┌────▼────┐
        │   LLM   │            │ Memory  │            │  Tools  │
        │ Service │            │ Service │            │ Registry│
        └────┬────┘            └────┬────┘            └────┬────┘
             │                      │                      │
       ┌─────┼─────┐                │              ┌───────┼───────┐
       │     │     │                │              │       │       │
    Ollama OpenAI OpenRouter     SQLite          Web     Shell   Data
```

## Quick start

### Requirements

- Node.js 20+
- npm
- Docker (recommended for production-style local deployment)
- Ollama for local inference

### Run directly

```bash
npm install
npm start
```

Open `http://127.0.0.1:8080`.

### Run with Docker

```bash
docker build -t gobi-replica .
docker run --rm --network host --env-file .env gobi-replica
```

### Local Ollama

Configure `.env` for local inference:

```env
LLM_PROVIDERS=ollama
LLM_MODEL=llama3.2:3b
OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
OLLAMA_MODEL=llama3.2:3b
```

Never commit `.env` or API keys. Use `.env.example` as the configuration template.

## API

### Health

```http
GET /health
```

### Chat

```http
POST /api/chat
Content-Type: application/json

{"message":"Hello Gobi"}
```

## Production-minded local deployment

This repository includes a `railpack.json` configuration for reproducible Node builds with the runtime utilities Gobi's tools may need. The application persists its SQLite state under `data/` when mounted into the container.

The recommended local runtime is:

```text
Host
 ├─ Ollama
 │   └─ local model
 │
 └─ Docker
     └─ Gobi Replica
         ├─ Agent Engine
         ├─ LLM Service
         ├─ Memory Service
         ├─ Tool Registry
         ├─ Scheduler
         └─ SQLite
```

## Project structure

```text
src/
├── agent/          Agent orchestration and task execution
├── services/       LLM, memory, SMS, email, and supporting services
├── tools/          Tool registry and executable capabilities
├── config.js       Runtime configuration
└── index.js        HTTP application entry point

railpack.json       Production-oriented Railpack build configuration
Dockerfile          Container definition
deploy.sh           Deployment helper
render.yaml         Render deployment configuration
```

## Security

Gobi is intended to operate with explicit tool boundaries and controlled runtime permissions. Keep credentials in environment variables, keep the container away from unnecessary host privileges, and review tool definitions before exposing the agent to untrusted input.

## Status

**Version:** `2.0.0`  
**Runtime:** Node.js 20+  
**Primary local model:** Ollama / `llama3.2:3b`  
**Port:** `8080`

## License

No license has been declared yet.

---

Built as a practical autonomous-agent runtime — local-first, extensible, and designed to grow into a serious workhorse.
