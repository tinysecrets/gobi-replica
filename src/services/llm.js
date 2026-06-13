import config from '../config.js';

/**
 * Multi-Provider LLM Service — v2
 *
 * Priority order (configurable via LLM_PROVIDERS env):
 *  1. OpenRouter (free-tier models, unlimited tokens)
 *  2. Ollama (local, fully offline)
 *  3. OpenAI (paid fallback)
 *
 * All providers speak OpenAI-compatible chat completions API.
 * The service tries each provider in order; on failure it fails over
 * to the next one automatically.
 */
class LLMService {
  constructor() {
    this.providers = config.llm.providers;
    this.defaultModel = config.llm.defaultModel;
  }

  /**
   * Build a fetch-based client call for any OpenAI-compatible endpoint.
   * We avoid the heavyweight `openai` npm package — zero telemetry, zero bloat.
   */
  async _callProvider(baseURL, apiKey, model, messages, options = {}, extraHeaders = {}) {
    const url = `${baseURL.replace(/\/+$/, '')}/chat/completions`;
    const headers = {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...extraHeaders,
    };

    const body = {
      model,
      messages,
      max_tokens: options.maxTokens || 4096,
      temperature: options.temperature ?? 0.7,
    };

    // Tools (function calling) — OpenAI-compatible format
    if (options.tools?.length) {
      body.tools = options.tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema || { type: 'object', properties: {}, required: [] },
        },
      }));
      body.tool_choice = options.tool_choice || 'auto';
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeout || 60000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`LLM provider returned ${res.status}: ${errText.slice(0, 300)}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message || { content: '', role: 'assistant' };
  }

  /** OpenRouter — free-tier models, OpenAI-compatible */
  async _tryOpenRouter(messages, options) {
    const cfg = config.llm.openrouter;
    if (!cfg.apiKey) throw new Error('OpenRouter API key not configured');

    const model = options.model || cfg.models[0] || this.defaultModel;
    return this._callProvider(cfg.baseURL, cfg.apiKey, model, messages, options, {
      'HTTP-Referer': cfg.httpReferer,
      'X-Title': cfg.appTitle,
    });
  }

  /** Ollama — local, no API key needed */
  async _tryOllama(messages, options) {
    const cfg = config.llm.ollama;
    const model = options.model || cfg.model;
    return this._callProvider(cfg.baseURL, '', model, messages, options);
  }

  /** OpenAI — paid fallback */
  async _tryOpenAI(messages, options) {
    const cfg = config.llm.openai;
    if (!cfg.apiKey) throw new Error('OpenAI API key not configured');

    const model = options.model || cfg.model;
    return this._callProvider('https://api.openai.com/v1', cfg.apiKey, model, messages, options);
  }

  /**
   * Main chat entry point. Tries providers in priority order.
   * Falls back to the next provider on any failure.
   */
  async chat(messages, options = {}) {
    const errors = [];

    for (const provider of this.providers) {
      try {
        switch (provider) {
          case 'openrouter':
            return await this._tryOpenRouter(messages, options);
          case 'ollama':
            return await this._tryOllama(messages, options);
          case 'openai':
            return await this._tryOpenAI(messages, options);
          default:
            errors.push(`Unknown provider: ${provider}`);
        }
      } catch (err) {
        errors.push(`${provider}: ${err.message}`);
        // Continue to next provider
      }
    }

    throw new Error(
      `All LLM providers failed:\n${errors.map(e => `  • ${e}`).join('\n')}`
    );
  }

  /**
   * Generate embeddings for semantic search / memory.
   * Uses OpenAI-compatible embeddings endpoint (works with Ollama too).
   */
  async embed(text, options = {}) {
    const model = options.model || config.llm.openai.model || 'text-embedding-3-small';

    // Try OpenAI first for embeddings, fall back to Ollama
    for (const provider of this.providers) {
      try {
        if (provider === 'openai' && config.llm.openai.apiKey) {
          const url = 'https://api.openai.com/v1/embeddings';
          const res = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${config.llm.openai.apiKey}`,
            },
            body: JSON.stringify({ model, input: text }),
            signal: AbortSignal.timeout(30000),
          });
          if (!res.ok) throw new Error(`OpenAI embeddings: ${res.status}`);
          const data = await res.json();
          return data.data?.[0]?.embedding || [];
        }

        if (provider === 'ollama') {
          const url = `${config.llm.ollama.baseURL.replace(/\/+$/, '')}/embeddings`;
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: config.llm.ollama.model, prompt: text }),
            signal: AbortSignal.timeout(30000),
          });
          if (!res.ok) throw new Error(`Ollama embeddings: ${res.status}`);
          const data = await res.json();
          return data.embedding || [];
        }
      } catch {
        // Try next provider
      }
    }

    // Fallback: return empty embedding (degrade gracefully)
    return [];
  }
}

export default LLMService;