import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, appendFileSync } from 'fs';
import crypto from 'crypto';
import config from '../config.js';
import { getAllTools, executeTool } from '../tools/registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '..', '..', 'data');

class WebServer {
  constructor(agentEngine, db, smsService = null) {
    this.app = express();
    this.agent = agentEngine;
    this.db = db;
    this.sms = smsService;
    this.port = config.port;
    this._setupMiddleware();
    this._setupRoutes();
  }

  _setupMiddleware() {
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));
    this.app.use(express.static(join(__dirname, 'public')));
  }

  _setupRoutes() {
    // ── Health Check ─────────────────────────────────────────────────
    this.app.get('/health', (req, res) => {
      res.json({ status: 'ok', agent: config.agentName, uptime: process.uptime() });
    });

    // ── Chat API ─────────────────────────────────────────────────────
    this.app.post('/api/chat', async (req, res) => {
      try {
        const { message } = req.body;
        if (!message || !message.trim()) {
          return res.status(400).json({ error: 'Message is required' });
        }
        const result = await this.agent.processMessage(message, {
          channel: 'web',
          address: req.ip || 'web-user',
          subject: 'Web Chat',
        });
        res.json(result);
      } catch (err) {
        console.error('Chat error:', err);
        res.status(500).json({ error: err.message });
      }
    });

    // ── SMS Webhook (Twilio) ─────────────────────────────────────────
    const webhookPath = config.sms.webhookPath;
    this.app.post(webhookPath, async (req, res) => {
      try {
        if (!this.sms) {
          return res.status(503).json({ error: 'SMS service not configured' });
        }
        const incoming = this.sms.handleIncoming(req.body);
        const result = await this.agent.processSMS(incoming);
        res.status(200).json({ status: 'ok', conversationId: result.conversationId });
      } catch (err) {
        console.error('SMS webhook error:', err);
        res.status(500).json({ error: err.message });
      }
    });

    // ── Conversation History ─────────────────────────────────────────
    this.app.get('/api/conversations', (req, res) => {
      const conversations = this.db.query(
        'SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 50'
      );
      res.json(conversations);
    });

    this.app.get('/api/conversations/:id/messages', (req, res) => {
      const messages = this.db.query(
        'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC',
        { id: req.params.id }
      );
      res.json(messages);
    });

    // ── Memory API ───────────────────────────────────────────────────
    this.app.get('/api/memory/search', async (req, res) => {
      try {
        const { q } = req.query;
        if (!q) return res.status(400).json({ error: 'Query param "q" is required' });
        const results = await this.agent.searchMemory(q);
        res.json(results);
      } catch (err) {
        console.error('Memory search error:', err);
        res.status(500).json({ error: err.message });
      }
    });

    this.app.get('/api/memory/facts', (req, res) => {
      const { category, key } = req.query;
      const facts = this.agent.recall(category || 'general', key || null);
      res.json(facts);
    });

    this.app.post('/api/memory/remember', async (req, res) => {
      try {
        const { category, key, value } = req.body;
        if (!category || !key || !value) {
          return res.status(400).json({ error: 'category, key, and value are required' });
        }
        const id = await this.agent.remember(category, key, value);
        res.json({ status: 'ok', id });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.delete('/api/memory/facts', (req, res) => {
      try {
        const { category, key } = req.body;
        if (!category || !key) {
          return res.status(400).json({ error: 'category and key are required' });
        }
        this.db.query('DELETE FROM agent_facts WHERE category = ? AND key = ?', { category, key });
        res.json({ status: 'ok', deleted: true });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // ── Search API (Multi-Engine with Geo-Targeting) ─────────────────
    this.app.post('/api/search', async (req, res) => {
      try {
        const { query, engine, geo_location, max_results } = req.body;
        if (!query || !query.trim()) {
          return res.status(400).json({ error: 'query is required' });
        }
        const params = { query: query.trim() };
        if (engine) params.engine = engine;
        if (geo_location) params.geo_location = geo_location;
        if (max_results) params.max_results = max_results;

        const contextObj = { db: this.db, conversationId: this.agent.conversationId };
        const result = await executeTool('web_search', params, contextObj);
        res.json(result);
      } catch (err) {
        console.error('Search API error:', err);
        res.status(500).json({ error: err.message });
      }
    });

    this.app.get('/api/search', async (req, res) => {
      try {
        const { q, engine, geo_location, max_results } = req.query;
        if (!q || !q.trim()) {
          return res.status(400).json({ error: 'Query param "q" is required' });
        }
        const params = { query: q.trim() };
        if (engine) params.engine = engine;
        if (geo_location) params.geo_location = geo_location;
        if (max_results) params.max_results = parseInt(max_results, 10);

        const contextObj = { db: this.db, conversationId: this.agent.conversationId };
        const result = await executeTool('web_search', params, contextObj);
        res.json(result);
      } catch (err) {
        console.error('Search API error:', err);
        res.status(500).json({ error: err.message });
      }
    });

    // ── Scrape API ───────────────────────────────────────────────────
    this.app.post('/api/scrape', async (req, res) => {
      try {
        const { url } = req.body;
        if (!url || !url.trim()) {
          return res.status(400).json({ error: 'url is required' });
        }
        const contextObj = { db: this.db, conversationId: this.agent.conversationId };
        const result = await executeTool('scrape_as_markdown', { url: url.trim() }, contextObj);
        res.json(result);
      } catch (err) {
        console.error('Scrape API error:', err);
        res.status(500).json({ error: err.message });
      }
    });

    this.app.get('/api/scrape', async (req, res) => {
      try {
        const { url } = req.query;
        if (!url || !url.trim()) {
          return res.status(400).json({ error: 'Query param "url" is required' });
        }
        const contextObj = { db: this.db, conversationId: this.agent.conversationId };
        const result = await executeTool('scrape_as_markdown', { url: url.trim() }, contextObj);
        res.json(result);
      } catch (err) {
        console.error('Scrape API error:', err);
        res.status(500).json({ error: err.message });
      }
    });

    // ── Logs API ─────────────────────────────────────────────────────
    this.app.get('/api/logs', (req, res) => {
      try {
        const { level, limit: limitParam, offset } = req.query;
        const limit = Math.min(parseInt(limitParam, 10) || 100, 500);
        const off = parseInt(offset, 10) || 0;

        // Try reading from DB first
        try {
          let query = 'SELECT * FROM app_logs ORDER BY created_at DESC LIMIT ? OFFSET ?';
          const params = { limit, offset: off };
          if (level) {
            query = 'SELECT * FROM app_logs WHERE level = ? ORDER BY created_at DESC LIMIT ? OFFSET ?';
            params.level = level;
          }
          const logs = this.db.query(query, params);
          if (logs && logs.length > 0) {
            return res.json({ logs, source: 'database' });
          }
        } catch {
          // Table may not exist — fall through to file-based logs
        }

        // Fallback: read log file
        const logFile = join(DATA_DIR, 'app.log');
        if (existsSync(logFile)) {
          const content = readFileSync(logFile, 'utf-8');
          const lines = content.split('\n').filter(Boolean).reverse();
          const sliced = lines.slice(off, off + limit);
          return res.json({ logs: sliced, source: 'file' });
        }

        res.json({ logs: [], source: 'none' });
      } catch (err) {
        console.error('Logs API error:', err);
        res.status(500).json({ error: err.message });
      }
    });

    this.app.post('/api/logs', (req, res) => {
      try {
        const { level, message, metadata } = req.body;
        if (!message) {
          return res.status(400).json({ error: 'message is required' });
        }
        const logLevel = level || 'info';
        const timestamp = new Date().toISOString();
        const logLine = `[${timestamp}] [${logLevel.toUpperCase()}] ${message}${metadata ? ' ' + JSON.stringify(metadata) : ''}`;

        console.log(logLine);

        // Try DB
        try {
          this.db.query(
            'INSERT INTO app_logs (level, message, metadata, created_at) VALUES (?, ?, ?, datetime(\'now\'))',
            { level: logLevel, message, metadata: metadata ? JSON.stringify(metadata) : null }
          );
        } catch {
          // Fallback: append to file
          const logDir = DATA_DIR;
          if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
          appendFileSync(join(logDir, 'app.log'), logLine + '\n');
        }

        res.json({ status: 'ok', timestamp });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.delete('/api/logs', (req, res) => {
      try {
        try {
          this.db.query('DELETE FROM app_logs');
        } catch {
          // Table may not exist
        }
        const logFile = join(DATA_DIR, 'app.log');
        if (existsSync(logFile)) {
          writeFileSync(logFile, '');
        }
        res.json({ status: 'ok', cleared: true });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // ── Settings API ─────────────────────────────────────────────────
    this.app.get('/api/settings', (req, res) => {
      try {
        const { key } = req.query;
        let settings;
        try {
          if (key) {
            settings = this.db.query('SELECT * FROM settings WHERE key = ?', { key });
          } else {
            settings = this.db.query('SELECT * FROM settings ORDER BY key ASC');
          }
        } catch {
          // Table may not exist
          settings = [];
        }

        // Merge in live config values
        const liveConfig = {
          agentName: config.agentName,
          agentRole: config.agentRole,
          port: config.port,
          nodeEnv: config.nodeEnv,
          dataDir: config.dataDir,
          llmProviders: config.llmProviders,
          llmModel: config.llmModel,
          smsEnabled: config.sms?.enabled || false,
          memoryMaxTurns: config.memory?.maxConversationTurns,
          memorySummarizeAfter: config.memory?.summarizeAfterTurns,
          memorySemanticThreshold: config.memory?.semanticSearchThreshold,
        };

        res.json({ settings, config: liveConfig });
      } catch (err) {
        console.error('Settings API error:', err);
        res.status(500).json({ error: err.message });
      }
    });

    this.app.put('/api/settings', (req, res) => {
      try {
        const { key, value } = req.body;
        if (!key) {
          return res.status(400).json({ error: 'key is required' });
        }

        // Ensure settings table exists
        try {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS settings (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL,
              metadata TEXT,
              updated_at TEXT DEFAULT(datetime('now'))
            )
          `);
        } catch { /* table exists */ }

        const valueStr = typeof value === 'object' ? JSON.stringify(value) : String(value);
        this.db.query(
          `INSERT OR REPLACE INTO settings (key, value, metadata, updated_at)
           VALUES (?, ?, ?, datetime('now'))`,
          { key, value: valueStr, metadata: typeof value === 'object' ? 'json' : 'string' }
        );

        res.json({ status: 'ok', key, value: valueStr });
      } catch (err) {
        console.error('Settings API error:', err);
        res.status(500).json({ error: err.message });
      }
    });

    this.app.delete('/api/settings', (req, res) => {
      try {
        const { key } = req.body;
        if (!key) {
          return res.status(400).json({ error: 'key is required' });
        }
        try {
          this.db.query('DELETE FROM settings WHERE key = ?', { key });
        } catch {
          res.status(404).json({ error: 'Settings table not found' });
          return;
        }
        res.json({ status: 'ok', deleted: true, key });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // ── Tool Definitions ─────────────────────────────────────────────
    this.app.get('/api/tools', (req, res) => {
      res.json(getAllTools());
    });

    this.app.get('/api/tool-results', (req, res) => {
      const results = this.db.query(
        'SELECT * FROM tool_results ORDER BY created_at DESC LIMIT 50'
      );
      res.json(results);
    });

    // ── Files ────────────────────────────────────────────────────────
    this.app.get('/api/files', (req, res) => {
      const exportsDir = join(DATA_DIR, 'exports');
      try {
        const files = readdirSync(exportsDir).map(f => {
          const stat = statSync(join(exportsDir, f));
          return { name: f, size: stat.size, modified: stat.mtime };
        });
        res.json(files);
      } catch {
        res.json([]);
      }
    });

    // ── Catch-all: SPA ───────────────────────────────────────────────
    this.app.get('*', (req, res) => {
      res.sendFile(join(__dirname, 'public', 'index.html'));
    });
  }

  start() {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, () => {
        console.log(`🌐 Web server running on port ${this.port}`);
        resolve(this.port);
      });
    });
  }

  stop() {
    if (this.server) this.server.close();
  }
}

export default WebServer;