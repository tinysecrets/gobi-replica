import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';

class DatabaseService {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.db = null;
  }

  init() {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }
    const dbPath = join(this.dataDir, 'agent.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this._createSchema();
    return this;
  }

  _createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        address TEXT NOT NULL,
        subject TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
        content TEXT,
        tool_calls TEXT,
        tool_results TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      );
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        key TEXT UNIQUE NOT NULL,
        value TEXT NOT NULL,
        category TEXT DEFAULT 'general',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        schedule TEXT NOT NULL,
        task_type TEXT NOT NULL,
        config TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER DEFAULT 1,
        last_run TEXT,
        next_run TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        address TEXT NOT NULL,
        name TEXT,
        status TEXT DEFAULT 'pending',
        allow_inbound INTEGER DEFAULT 1,
        allow_outbound INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(channel, address)
      );
      CREATE TABLE IF NOT EXISTS tool_results (
        id TEXT PRIMARY KEY,
        tool_name TEXT NOT NULL,
        params TEXT,
        result TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_memories_key ON memories(key);
    `);
  }

  query(sql, params = {}) {
    const stmt = this.db.prepare(sql);
    if (sql.trim().toUpperCase().startsWith('SELECT') || sql.trim().toUpperCase().startsWith('WITH')) {
      return stmt.all(params);
    }
    return stmt.run(params);
  }

  exec(sql) { return this.db.exec(sql); }
  get(sql, params = {}) { return this.db.prepare(sql).get(params); }
  close() { if (this.db) this.db.close(); }
}

export default DatabaseService;
