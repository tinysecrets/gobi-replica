import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '..', '.env') });

const config = {
  // Agent identity
  agentName: process.env.AGENT_NAME || 'Patrick',
  agentRole: process.env.AGENT_ROLE || 'Autonomous AI Agent',

  // ─── Multi-Provider LLM ───────────────────────────────────────────────
  llm: {
    // Provider priority order: openrouter > ollama > openai
    providers: (process.env.LLM_PROVIDERS || 'openrouter,ollama,openai').split(',').map(s => s.trim()),
    defaultModel: process.env.LLM_MODEL || 'meta-llama/llama-3.2-3b-instruct:free',

    // OpenRouter (free tier models, OpenAI-compatible)
    openrouter: {
      apiKey: process.env.OPENROUTER_API_KEY || '',
      baseURL: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
      models: (process.env.OPENROUTER_MODELS || 'meta-llama/llama-3.2-3b-instruct:free,google/gemma-2-9b-it:free').split(',').map(s => s.trim()),
      httpReferer: process.env.OPENROUTER_HTTP_REFERER || 'https://github.com/gobi-replica',
      appTitle: process.env.OPENROUTER_APP_TITLE || 'Gobi Replica',
    },

    // Ollama (local, OpenAI-compatible)
    ollama: {
      baseURL: process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1',
      model: process.env.OLLAMA_MODEL || 'llama3.2:3b',
      // No API key needed for local Ollama
    },

    // OpenAI (paid fallback)
    openai: {
      apiKey: process.env.OPENAI_API_KEY || '',
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    },
  },

  // ─── Web Server ───────────────────────────────────────────────────────
  port: parseInt(process.env.PORT || '8080', 10),
  sessionSecret: process.env.SESSION_SECRET || 'change-me-in-production',

  // ─── Email (SMTP) ─────────────────────────────────────────────────────
  email: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.EMAIL_FROM || 'agent@localhost',
  },

  // ─── Twilio SMS Gateway ───────────────────────────────────────────────
  sms: {
    enabled: process.env.SMS_ENABLED === 'true',
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    fromNumber: process.env.TWILIO_FROM_NUMBER || '',
    webhookPath: process.env.SMS_WEBHOOK_PATH || '/api/sms/webhook',
  },

  // ─── Memory & Context ─────────────────────────────────────────────────
  memory: {
    maxConversationTurns: parseInt(process.env.MEMORY_MAX_TURNS || '50', 10),
    embeddingModel: process.env.MEMORY_EMBEDDING_MODEL || 'text-embedding-3-small',
    embeddingDimension: parseInt(process.env.MEMORY_EMBEDDING_DIM || '1536', 10),
    semanticSearchThreshold: parseFloat(process.env.MEMORY_SEMANTIC_THRESHOLD || '0.7'),
    summarizeAfterTurns: parseInt(process.env.MEMORY_SUMMARIZE_AFTER || '20', 10),
  },

  // ─── Data Directory ───────────────────────────────────────────────────
  dataDir: process.env.DATA_DIR || join(__dirname, '..', 'data'),

  // ─── Bright Data (optional proxy for web search/scraping) ────────────
  brightData: {
    proxy: process.env.BRIGHTDATA_PROXY || '',
    apiToken: process.env.BRIGHTDATA_API_TOKEN || '',
  },
};

export default config;