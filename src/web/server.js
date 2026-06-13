import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import crypto from 'crypto';
import config from '../config.js';
import { getAllTools } from '../tools/registry.js';

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

    // ── Memory Search ────────────────────────────────────────────────
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
