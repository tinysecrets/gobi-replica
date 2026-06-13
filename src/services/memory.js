import DatabaseService from './database.js';
import config from '../config.js';

/**
 * Advanced Memory & Context Service — v2
 *
 * Features:
 *   • Conversation turn storage with full history
 *   • Automatic summarization after N turns
 *   • Semantic search via embeddings (cosine similarity)
 *   • Keyword search via SQLite FTS5
 *   • Context window management (sliding window + summaries)
 *
 * Embeddings are stored as JSON arrays. Cosine similarity is computed
 * in JavaScript for portability (no native vector extension required).
 * This keeps the stack 100 % SQLite + Node.js — zero external vector DB.
 */
class MemoryService {
  constructor() {
    this.db = new DatabaseService();
    this.maxTurns = config.memory.maxConversationTurns;
    this.summarizeAfter = config.memory.summarizeAfterTurns;
    this.semanticThreshold = config.memory.semanticSearchThreshold;
    this.embeddingDim = config.memory.embeddingDimension;
  }

  init() {
    this.db.init();
    this._ensureTables();
    return this;
  }

  /** Create memory tables if they don't exist */
  _ensureTables() {
    // Conversation turns
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
        content TEXT NOT NULL,
        tool_calls TEXT,
        tool_result TEXT,
        embedding TEXT,
        created_at TEXT DEFAULT(datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_turns_session ON conversation_turns(session_id, created_at);
    `);

    // Summaries (rolled-up context for long conversations)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        turn_count INTEGER NOT NULL,
        created_at TEXT DEFAULT(datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_summaries_session ON conversation_summaries(session_id, created_at);
    `);

    // FTS5 virtual table for keyword search over turns
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
        content,
        session_id UNINDEXED,
        turn_id UNINDEXED,
        tokenize='porter'
      );
    `);

    // Triggers to keep FTS in sync
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS turns_fts_insert AFTER INSERT ON conversation_turns BEGIN
        INSERT INTO turns_fts(content, session_id, turn_id)
        VALUES (NEW.content, NEW.session_id, NEW.id);
      END;
      CREATE TRIGGER IF NOT EXISTS turns_fts_delete AFTER DELETE ON conversation_turns BEGIN
        INSERT INTO turns_fts(turns_fts, rowid, content, session_id, turn_id)
        VALUES ('delete', OLD.id, OLD.content, OLD.session_id, OLD.id);
      END;
    `);

    // Agent facts / long-term memory
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        embedding TEXT,
        source TEXT,
        confidence REAL DEFAULT 1.0,
        created_at TEXT DEFAULT(datetime('now')),
        updated_at TEXT DEFAULT(datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_facts_category ON agent_facts(category, key);
    `);
  }

  /** Store a conversation turn */
  addTurn(sessionId, role, content, metadata = {}) {
    const stmt = this.db.prepare(`
      INSERT INTO conversation_turns (session_id, role, content, tool_calls, tool_result, embedding)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      sessionId,
      role,
      content,
      metadata.tool_calls ? JSON.stringify(metadata.tool_calls) : null,
      metadata.tool_result ? JSON.stringify(metadata.tool_result) : null,
      metadata.embedding ? JSON.stringify(metadata.embedding) : null
    );
    return result.lastInsertRowid;
  }

  /** Retrieve recent conversation turns for a session */
  getRecentTurns(sessionId, limit = this.maxTurns) {
    return this.db.prepare(`
      SELECT id, role, content, tool_calls, tool_result, created_at
      FROM conversation_turns
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(sessionId, limit).reverse();
  }

  /** Count turns in a session */
  countTurns(sessionId) {
    const row = this.db.prepare(`SELECT COUNT(*) as count FROM conversation_turns WHERE session_id = ?`).get(sessionId);
    return row?.count || 0;
  }

  /** Build a context window: summary + recent turns */
  buildContext(sessionId, options = {}) {
    const maxTurns = options.maxTurns || this.maxTurns;
    const turns = this.getRecentTurns(sessionId, maxTurns);

    // Fetch the latest summary for this session
    const summary = this.db.prepare(`
      SELECT summary FROM conversation_summaries
      WHERE session_id = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(sessionId);

    const messages = [];
    if (summary) {
      messages.push({ role: 'system', content: `Conversation summary so far: ${summary.summary}` });
    }

    for (const turn of turns) {
      messages.push({
        role: turn.role,
        content: turn.content,
        ...(turn.tool_calls ? { tool_calls: JSON.parse(turn.tool_calls) } : {}),
      });
    }

    return messages;
  }

  /** Summarize conversation turns and store the summary */
  async summarizeAndStore(sessionId, llmService) {
    const turns = this.getRecentTurns(sessionId, this.summarizeAfter * 2);
    if (turns.length < this.summarizeAfter) return;

    const conversationText = turns.map(t => `${t.role}: ${t.content}`).join('\n');
    const summaryPrompt = `Summarize the following conversation concisely, preserving key facts, decisions, and context:\n\n${conversationText}`;

    try {
      const summaryMsg = await llmService.chat([
        { role: 'system', content: 'You are a summarization assistant. Condense conversations while keeping all important facts.' },
        { role: 'user', content: summaryPrompt },
      ], { maxTokens: 512 });

      this.db.prepare(`INSERT INTO conversation_summaries (session_id, summary, turn_count) VALUES (?, ?, ?)`)
        .run(sessionId, summaryMsg.content || '', turns.length);

      // Optionally: delete old raw turns to save space (keep last N)
      const idsToKeep = turns.slice(-this.summarizeAfter).map(t => t.id);
      const placeholders = idsToKeep.map(() => '?').join(',');
      this.db.prepare(`DELETE FROM conversation_turns WHERE session_id = ? AND id NOT IN (${placeholders})`)
        .run(sessionId, ...idsToKeep);
    } catch {
      // Fail silently — summarization is best-effort
    }
  }

  /** Cosine similarity between two embedding vectors */
  cosineSimilarity(a, b) {
    if (!a?.length || !b?.length || a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  /** Semantic search over conversation turns using embeddings */
  semanticSearch(sessionId, queryEmbedding, limit = 5) {
    const rows = this.db.prepare(`
      SELECT id, role, content, embedding, created_at
      FROM conversation_turns
      WHERE session_id = ? AND embedding IS NOT NULL
    `).all(sessionId);

    const scored = rows.map(r => ({
      ...r,
      similarity: this.cosineSimilarity(queryEmbedding, JSON.parse(r.embedding)),
    }));

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.filter(r => r.similarity >= this.semanticThreshold).slice(0, limit);
  }

  /** Keyword search via SQLite FTS5 */
  keywordSearch(sessionId, query, limit = 5) {
    return this.db.prepare(`
      SELECT t.id, t.role, t.content, t.created_at
      FROM turns_fts fts
      JOIN conversation_turns t ON fts.turn_id = t.id
      WHERE turns_fts MATCH ? AND fts.session_id = ?
      ORDER BY rank
      LIMIT ?
    `).all(query, sessionId, limit);
  }

  /** Hybrid search: combine semantic + keyword results */
  searchContext(sessionId, queryEmbedding, queryText, limit = 5) {
    const semantic = this.semanticSearch(sessionId, queryEmbedding, limit);
    const keyword = this.keywordSearch(sessionId, queryText, limit);

    // Deduplicate and merge
    const seen = new Set();
    const results = [];
    for (const r of [...semantic, ...keyword]) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        results.push(r);
      }
    }
    return results.slice(0, limit);
  }

  /** Store a long-term fact */
  storeFact(category, key, value, embedding = null, source = null, confidence = 1.0) {
    const existing = this.db.prepare(`SELECT id FROM agent_facts WHERE category = ? AND key = ?`).get(category, key);
    if (existing) {
      this.db.prepare(`UPDATE agent_facts SET value = ?, embedding = ?, source = ?, confidence = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(value, embedding ? JSON.stringify(embedding) : null, source, confidence, existing.id);
      return existing.id;
    }
    const result = this.db.prepare(`INSERT INTO agent_facts (category, key, value, embedding, source, confidence) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(category, key, value, embedding ? JSON.stringify(embedding) : null, source, confidence);
    return result.lastInsertRowid;
  }

  /** Retrieve facts by category */
  getFacts(category, key = null) {
    if (key) {
      return this.db.prepare(`SELECT * FROM agent_facts WHERE category = ? AND key = ? ORDER BY updated_at DESC`).all(category, key);
    }
    return this.db.prepare(`SELECT * FROM agent_facts WHERE category = ? ORDER BY updated_at DESC`).all(category);
  }

  /** Search facts semantically */
  searchFacts(queryEmbedding, category = null, limit = 5) {
    let rows;
    if (category) {
      rows = this.db.prepare(`SELECT * FROM agent_facts WHERE category = ? AND embedding IS NOT NULL`).all(category);
    } else {
      rows = this.db.prepare(`SELECT * FROM agent_facts WHERE embedding IS NOT NULL`).all();
    }
    const scored = rows.map(r => ({
      ...r,
      similarity: this.cosineSimilarity(queryEmbedding, JSON.parse(r.embedding)),
    }));
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.filter(r => r.similarity >= this.semanticThreshold).slice(0, limit);
  }
}

export default MemoryService;