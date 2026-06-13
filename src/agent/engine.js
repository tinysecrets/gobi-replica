import { v4 as uuidv4 } from 'uuid';
import { getAllTools, executeTool } from '../tools/registry.js';
import LLMService from '../services/llm.js';
import MemoryService from '../services/memory.js';
import SMSService from '../services/sms.js';
import config from '../config.js';

class AgentEngine {
  constructor(db, llmService, memoryService, smsService) {
    this.db = db;
    this.llm = llmService;
    this.memory = memoryService;
    this.sms = smsService;
    this.systemPrompt = this._buildSystemPrompt();
    this.conversationId = null;
    this.sessionId = `session_${Date.now()}`;
  }

  _buildSystemPrompt() {
    return `You are Gobi Replica, an Autonomous AI Agent built to handle any professional task.

## Identity & Role
- Name: Gobi Replica
- Role: Autonomous AI Agent — Professional, capable, reliable
- You solve problems, answer questions, perform research, manage data, create files, send messages, automate tasks, and handle any job a professional would need.

## Core Principles
1. Be persistent — use your tools fully to fulfill requests
2. Be grounded — cite sources, verify facts, use evidence
3. Be concise — deliver results without unnecessary narration
4. Be transparent — share findings, blockers, and decisions

## Capabilities Summary
You have access to a comprehensive toolset including:
- **Web**: Search, scrape, browse (SERP, scraping, browser automation)
- **Data**: SQLite queries, file creation/manipulation, CSV/PDF exports
- **Communication**: Send messages via email & SMS, read files, write output
- **Code Execution**: Run shell commands, execute Python scripts
- **Visual**: Generate charts, images, and creative content
- **Memory**: Persistent context, semantic search, conversation summaries
- **Planning**: Track task plans and progress

## Task Execution
1. Understand the user's request fully
2. Use the right tools in the right order
3. Deliver complete, polished results
4. If blocked, explain the blocker clearly
5. For multi-step work, track progress

## Output Format
- Use clear Markdown for responses
- Include source URLs and citations when applicable
- Present data in tables when helpful
- Be professional and direct`;
  }

  async processMessage(userMessage, context = {}) {
    // Create or get conversation
    if (!this.conversationId) {
      this.conversationId = uuidv4();
      this.db.prepare(`INSERT INTO conversations (id, channel, address, subject, created_at) VALUES (?, ?, ?, ?, datetime('now'))`)
        .run(this.conversationId, context.channel || 'web', context.address || 'user', context.subject || 'Chat');
    }

    // Save user message to DB
    this.db.prepare(`INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, 'user', ?, datetime('now'))`)
      .run(uuidv4(), this.conversationId, userMessage);

    // Save user turn to memory service
    this.memory.addTurn(this.sessionId, 'user', userMessage);

    // Check if we should summarize (auto-rollup long conversations)
    const turnCount = this.memory.countTurns(this.sessionId);
    if (turnCount >= config.memory.summarizeAfterTurns) {
      await this.memory.summarizeAndStore(this.sessionId, this.llm);
    }

    // Build context from memory (summary + recent turns)
    const messages = this.memory.buildContext(this.sessionId, { maxTurns: config.memory.maxConversationTurns });
    // Prepend system prompt if not already present
    if (!messages.length || messages[0]?.role !== 'system') {
      messages.unshift({ role: 'system', content: this.systemPrompt });
    }

    // Get available tools
    const tools = getAllTools();

    // Call LLM
    let response;
    const toolCallsExecuted = [];
    const maxIterations = 10;

    for (let i = 0; i < maxIterations; i++) {
      response = await this.llm.chat(messages, { tools, tool_choice: 'auto' });

      if (response.tool_calls && response.tool_calls.length > 0) {
        // Process each tool call
        for (const tc of response.tool_calls) {
          const toolName = tc.function.name;
          let params = {};
          try {
            params = JSON.parse(tc.function.arguments || '{}');
          } catch { params = {}; }

          const contextObj = { db: this.db, conversationId: this.conversationId };
          let result;

          try {
            result = await executeTool(toolName, params, contextObj);
          } catch (err) {
            result = { error: err.message };
          }

          toolCallsExecuted.push({ name: toolName, params, result });

          // Log tool result as message in DB
          this.db.prepare(`INSERT INTO messages (id, conversation_id, role, content, tool_calls, tool_results, created_at) VALUES (?, ?, 'tool', ?, ?, ?, datetime('now'))`)
            .run(uuidv4(), this.conversationId, '', JSON.stringify([{ id: tc.id, function: { name: toolName, arguments: tc.function.arguments } }]), JSON.stringify(result));

          // Add to messages for next LLM call
          messages.push({
            role: 'assistant',
            content: response.content || null,
            tool_calls: response.tool_calls.map(tc => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.function.name, arguments: tc.function.arguments }
            })),
          });
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(result),
          });
        }

        // Clear tool_calls for next iteration
        response.tool_calls = undefined;
      } else {
        // No tool calls — final response
        break;
      }
    }

    const finalContent = response?.content || 'Task completed.';

    // Save assistant turn to memory
    this.memory.addTurn(this.sessionId, 'assistant', finalContent);

    // Save assistant response to DB
    this.db.prepare(`INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, 'assistant', ?, datetime('now'))`)
      .run(uuidv4(), this.conversationId, finalContent);

    // Update conversation timestamp
    this.db.prepare(`UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`).run(this.conversationId);

    return {
      response: finalContent,
      toolCalls: toolCallsExecuted,
      conversationId: this.conversationId,
      sessionId: this.sessionId,
    };
  }

  /** Process an incoming SMS message */
  async processSMS(incomingMessage) {
    const userMessage = incomingMessage.body;
    const context = {
      channel: 'sms',
      address: incomingMessage.from,
      subject: `SMS from ${incomingMessage.from}`,
    };

    const result = await this.processMessage(userMessage, context);

    // Auto-reply via SMS if enabled
    if (config.sms.enabled && result.response) {
      try {
        await this.sms.send(incomingMessage.from, result.response.slice(0, 1600));
      } catch (err) {
        // Log but don't fail the whole flow
        console.error('SMS auto-reply failed:', err.message);
      }
    }

    return result;
  }

  /** Search conversation memory for relevant context */
  async searchMemory(queryText) {
    // Get embedding for the query
    const queryEmbedding = await this.llm.embed(queryText);

    // Hybrid search: semantic + keyword
    const results = this.memory.searchContext(
      this.sessionId,
      queryEmbedding,
      queryText,
      5
    );

    return results;
  }

  /** Store a long-term fact in agent memory */
  async remember(category, key, value, source = null, confidence = 1.0) {
    // Generate embedding for semantic recall later
    let embedding = null;
    try {
      embedding = await this.llm.embed(value);
    } catch { /* best-effort */ }

    return this.memory.storeFact(category, key, value, embedding, source, confidence);
  }

  /** Recall facts by category and optional key */
  recall(category, key = null) {
    return this.memory.getFacts(category, key);
  }
}

export default AgentEngine;