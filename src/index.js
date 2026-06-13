import config from './config.js';
import DatabaseService from './services/database.js';
import LLMService from './services/llm.js';
import MemoryService from './services/memory.js';
import SMSService from './services/sms.js';
import EmailService from './services/email.js';
import SchedulerService from './services/scheduler.js';
import AgentEngine from './agent/engine.js';
import WebServer from './web/server.js';

// ─── Initialize Services ───────────────────────────────────────────────────
const db = new DatabaseService(config.dataDir).init();
console.log('🗄️  Database initialized');

const llm = new LLMService();
console.log('🧠 LLM service ready (multi-provider: openrouter, ollama, openai)');

const memory = new MemoryService().init();
console.log('🧠 Memory service ready (semantic + keyword search)');

const sms = new SMSService();
if (config.sms.enabled) console.log('📱 SMS service ready (Twilio)');

const email = new EmailService().init();
if (email.transporter) console.log('📧 Email service ready');

const scheduler = new SchedulerService();
console.log('⏰ Scheduler ready');

// ─── Initialize Agent ──────────────────────────────────────────────────────
const agent = new AgentEngine(db, llm, memory, sms);
console.log('🤖 Agent engine initialized');

// ─── Start Web Server ──────────────────────────────────────────────────────
const webServer = new WebServer(agent, db, sms);
await webServer.start();

console.log(`\n✅ ${config.agentName} running on port ${config.port}`);

// ─── Graceful Shutdown ─────────────────────────────────────────────────────
function shutdown() {
    console.log('\n🛑 Shutting down...');
    scheduler.stopAll();
    webServer.stop();
    db.close();
    process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ─── Error Handling ────────────────────────────────────────────────────────
process.on('unhandledRejection', (err) => {
    console.error('⚠️  Unhandled rejection:', err.message);
});
