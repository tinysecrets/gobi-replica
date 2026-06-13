import { v4 as uuidv4 } from 'uuid';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '..', '..', 'data');

// ─── Tool Definition ───────────────────────────────────────────────────────
class Tool {
  constructor(def, handler) {
    this.name = def.name;
    this.description = def.description;
    this.inputSchema = def.inputSchema;
    this.handler = handler;
  }
}

// ─── SQL Schema for __tool_results snapshot ────────────────────────────────
function ensureResultsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS __tool_results (
      result_id TEXT PRIMARY KEY,
      tool_name TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      result_json TEXT,
      result_text TEXT,
      bytes INTEGER,
      line_count INTEGER,
      is_json INTEGER DEFAULT 0,
      json_type TEXT,
      top_keys TEXT,
      is_truncated INTEGER DEFAULT 0,
      analysis_json TEXT
    )
  `);
}

// ─── Tool Implementations ──────────────────────────────────────────────────

const tools = {};

// 1. sqlite_batch - Execute SQL queries
tools.sqlite_batch = new Tool(
  {
    name: 'sqlite_batch',
    description: 'Execute SQL queries via better-sqlite3. Supports multiple semicolon-separated statements.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'SQL string with semicolon-separated statements.' },
      },
      required: ['sql'],
    },
  },
  async (params, { db }) => {
    const results = [];
    const stmts = params.sql.split(';').filter(s => s.trim());
    for (const stmt of stmts) {
      try {
        const trimmed = stmt.trim().toUpperCase();
        if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH') || trimmed.startsWith('PRAGMA')) {
          const rows = db.prepare(stmt).all();
          results.push({ result: rows, rowCount: rows.length });
        } else {
          const info = db.prepare(stmt).run();
          results.push({ changes: info.changes, lastInsertRowid: info.lastInsertRowid });
        }
      } catch (err) {
        results.push({ error: err.message });
      }
    }
    return { status: 'ok', results, db_size_mb: null };
  }
);

// 2. http_request - HTTP requests
tools.http_request = new Tool(
  {
    name: 'http_request',
    description: 'Make HTTP/HTTPS requests to fetch structured data or interact with APIs.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] },
        url: { type: 'string', format: 'uri' },
        headers: { type: 'object', description: 'Optional HTTP headers.' },
        body: { type: 'string', description: 'Optional request body.' },
        download: { type: 'boolean', description: 'Whether to save response to filespace.' },
      },
      required: ['method', 'url'],
    },
  },
  async (params) => {
    // Node 20+ has global fetch available
    const opts = {
      method: params.method,
      headers: params.headers || { 'User-Agent': 'GobiReplica/1.0' },
    };
    if (params.body && params.method !== 'GET') opts.body = params.body;
    const response = await fetch(params.url, opts);
    const contentType = response.headers.get('content-type') || '';
    let result;
    let isJson = false;
    if (contentType.includes('application/json')) {
      result = await response.json();
      isJson = true;
    } else {
      result = await response.text();
    }
    return {
      status: 'ok',
      statusCode: response.status,
      contentType,
      isJson,
      result,
    };
  }
);

// 3. read_file - Read files from filespace
tools.read_file = new Tool(
  {
    name: 'read_file',
    description: 'Read a file from the agent filespace as text or markdown.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to file in filespace.' },
        max_chars: { type: 'integer', description: 'Max characters to return.' },
        response_format: { type: 'string', enum: ['raw_text', 'markdown'] },
      },
      required: ['path'],
    },
  },
  async (params) => {
    const filePath = params.path.replace('$[/', '').replace(']', '');
    const fullPath = join(__dirname, '..', '..', filePath);
    if (!existsSync(fullPath)) return { error: `File not found: ${params.path}` };
    let content = readFileSync(fullPath, 'utf-8');
    const truncated = params.max_chars && content.length > params.max_chars;
    if (truncated) content = content.slice(0, params.max_chars) + '\n... [truncated]';
    return { status: 'ok', text: content, format: params.response_format || 'raw_text', truncated };
  }
);

// 4. search_tools / web_search (Bright Data)
tools.web_search = new Tool(
  {
    name: 'web_search',
    description: 'Search the web using Bright Data SERP API or fallback.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
        engine: { type: 'string', enum: ['google', 'bing'], default: 'google' },
        geo_location: { type: 'string', description: '2-letter country code.' },
      },
      required: ['query'],
    },
  },
  async (params) => {
    // Fallback to a simple approach: use a public search API or fetch
    const query = encodeURIComponent(params.query);
    const url = `https://html.duckduckgo.com/html/?q=${query}`;
    // Node 20+ has global fetch
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html = await res.text();
    return { status: 'ok', engine: 'duckduckgo_fallback', html_length: html.length, note: 'DuckDuckGo HTML fallback. Bright Data API key recommended for structured results.' };
  }
);

// 5. scrape_as_markdown (Bright Data)
tools.scrape_as_markdown = new Tool(
  {
    name: 'scrape_as_markdown',
    description: 'Scrape a webpage URL and extract content as Markdown.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', format: 'uri', description: 'URL to scrape.' },
      },
      required: ['url'],
    },
  },
  async (params) => {
    // Fallback: fetch and extract basic text
    // Node 20+ has global fetch
    const res = await fetch(params.url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GobiReplica/1.0)' } });
    const html = await res.text();
    // Simple extraction - strip tags
    const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 10000);
    return { status: 'ok', url: params.url, result: text, note: 'Basic HTML extraction. Bright Data API key provides richer results.' };
  }
);

// 6. create_file - Create files in filespace
tools.create_file = new Tool(
  {
    name: 'create_file',
    description: 'Create a text file in the agent filespace.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Desired filespace path (e.g. /exports/report.txt).' },
        content: { type: 'string', description: 'File content.' },
        mime_type: { type: 'string', description: 'MIME type.' },
      },
      required: ['file_path', 'content', 'mime_type'],
    },
  },
  async (params) => {
    const cleanPath = params.file_path.replace(/^\$?\[?\/?/, '/');
    const fullPath = join(__dirname, '..', '..', cleanPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, params.content, 'utf-8');
    return {
      status: 'ok',
      file: `$[${cleanPath}]`,
      path: cleanPath,
      bytes: Buffer.byteLength(params.content, 'utf-8'),
    };
  }
);

// 7. create_csv - Create CSV files
tools.create_csv = new Tool(
  {
    name: 'create_csv',
    description: 'Export data to a CSV file.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Output path (e.g. /exports/data.csv).' },
        csv_text: { type: 'string', description: 'Raw CSV content.' },
        query: { type: 'string', description: 'SQLite SELECT query to export.' },
      },
      required: ['file_path'],
    },
  },
  async (params, { db }) => {
    let csvContent;
    if (params.query) {
      const rows = db.prepare(params.query).all();
      if (rows.length === 0) return { status: 'ok', path: params.file_path, rows: 0 };
      const headers = Object.keys(rows[0]);
      const csvLines = [headers.join(',')];
      for (const row of rows) {
        csvLines.push(headers.map(h => {
          const val = row[h];
          if (val === null || val === undefined) return '';
          const str = String(val);
          return str.includes(',') || str.includes('"') ? `"${str.replace(/"/g, '""')}"` : str;
        }).join(','));
      }
      csvContent = csvLines.join('\n');
    } else {
      csvContent = params.csv_text;
    }
    const cleanPath = params.file_path.replace(/^\$?\[?\/?/, '/');
    const fullPath = join(__dirname, '..', '..', cleanPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, csvContent, 'utf-8');
    const rows = csvContent.split('\n').length - 1;
    return { status: 'ok', file: `$[${cleanPath}]`, rows };
  }
);

// 8. create_chart - Simple SVG chart generation
tools.create_chart = new Tool(
  {
    name: 'create_chart',
    description: 'Generate a simple SVG bar/line/pie chart from SQL query.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['bar', 'line', 'pie', 'donut', 'horizontal_bar'] },
        query: { type: 'string', description: 'SQL SELECT query.' },
        title: { type: 'string', description: 'Chart title.' },
        xlabel: { type: 'string', description: 'X-axis label.' },
        ylabel: { type: 'string', description: 'Y-axis label.' },
      },
      required: ['type', 'query'],
    },
  },
  async (params, { db }) => {
    const rows = db.prepare(params.query).all();
    if (rows.length === 0) return { error: 'Query returned no rows.' };
    const cols = Object.keys(rows[0]);
    const labels = rows.map(r => String(r[cols[0]]));
    const values = rows.map(r => Number(r[cols[1]]) || 0);
    const maxVal = Math.max(...values, 1);
    const width = 600, height = 400, padding = 60;
    const chartWidth = width - padding * 2;
    const chartHeight = height - padding * 2;
    const barWidth = Math.max(10, chartWidth / labels.length - 5);
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n`;
    if (params.title) svg += `<text x="${width/2}" y="25" text-anchor="middle" font-size="16" font-weight="bold">${params.title.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</text>\n`;
    // Y axis
    svg += `<line x1="${padding}" y1="${padding}" x2="${padding}" y2="${height-padding}" stroke="#333" stroke-width="1"/>\n`;
    svg += `<line x1="${padding}" y1="${height-padding}" x2="${width-padding}" y2="${height-padding}" stroke="#333" stroke-width="1"/>\n`;
    if (params.ylabel) svg += `<text x="15" y="${height/2}" text-anchor="middle" font-size="12" transform="rotate(-90,15,${height/2})">${params.ylabel.replace(/&/g,'&amp;')}</text>\n`;
    for (let i = 0; i < 5; i++) {
      const yVal = Math.round((maxVal / 4) * i);
      const yPos = height - padding - (chartHeight * i / 4);
      svg += `<text x="${padding-5}" y="${yPos+4}" text-anchor="end" font-size="10" fill="#666">${yVal}</text>\n`;
      if (i > 0) svg += `<line x1="${padding}" y1="${yPos}" x2="${width-padding}" y2="${yPos}" stroke="#eee" stroke-width="1"/>\n`;
    }
    const colors = ['#4e79a7','#f28e2b','#e15759','#76b7b2','#59a14f','#edc948','#b07aa1','#ff9da7','#9c755f','#bab0ac'];
    for (let i = 0; i < values.length; i++) {
      const barH = (values[i] / maxVal) * chartHeight;
      const x = padding + (i * (chartWidth / labels.length)) + (chartWidth / labels.length - barWidth) / 2;
      const y = height - padding - barH;
      svg += `<rect x="${x}" y="${y}" width="${barWidth}" height="${barH}" fill="${colors[i % colors.length]}" rx="2"/>\n`;
      if (labels.length <= 15) {
        const label = labels[i].length > 10 ? labels[i].slice(0,10)+'…' : labels[i];
        svg += `<text x="${x+barWidth/2}" y="${height-padding+14}" text-anchor="end" font-size="8" transform="rotate(-45,${x+barWidth/2},${height-padding+14})">${label.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</text>\n`;
      }
    }
    svg += '</svg>';
    const filePath = `/data/exports/chart_${Date.now()}.svg`;
    const fullPath = join(__dirname, '..', '..', filePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, svg, 'utf-8');
    return { status: 'ok', file: `$[${filePath}]`, svg, labels, values };
  }
);

// 9. update_plan / plan management
tools.update_plan = new Tool(
  {
    name: 'update_plan',
    description: 'Update the agent task plan with step statuses.',
    inputSchema: {
      type: 'object',
      properties: {
        plan: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              step: { type: 'string' },
              status: { type: 'string', enum: ['todo', 'doing', 'done'] },
            },
            required: ['step', 'status'],
          },
        },
      },
      required: ['plan'],
    },
  },
  async (params, { db }) => {
    const serialized = JSON.stringify(params.plan);
    // Store in memories
    const id = uuidv4();
    db.prepare(`INSERT OR REPLACE INTO memories (id, key, value, category, updated_at) VALUES (?, 'active_plan', ?, 'plan', datetime('now'))`).run(id, serialized);
    return { status: 'ok', message: 'Plan updated.', step_count: params.plan.length };
  }
);

// 10. send_chat_message / send_message
tools.send_message = new Tool(
  {
    name: 'send_message',
    description: 'Send a message to the user via active channel.',
    inputSchema: {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'Message content.' },
        channel: { type: 'string', enum: ['web', 'email'], description: 'Delivery channel.' },
        subject: { type: 'string', description: 'Email subject (for email channel).' },
      },
      required: ['body'],
    },
  },
  async (params) => {
    return {
      status: 'ok',
      message: 'Message queued for delivery.',
      body_preview: params.body.slice(0, 100),
      channel: params.channel || 'web',
      note: 'In production, integrate with SMTP/webhook for actual delivery.',
    };
  }
);

// 11. run_command - Execute shell commands
tools.run_command = new Tool(
  {
    name: 'run_command',
    description: 'Execute a non-interactive shell command in the sandbox.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute.' },
        timeout_seconds: { type: 'integer', description: 'Optional timeout.' },
      },
      required: ['command'],
    },
  },
  async (params) => {
    try {
      const opts = { timeout: (params.timeout_seconds || 30) * 1000, maxBuffer: 10 * 1024 * 1024 };
      const stdout = execSync(params.command, opts).toString();
      return { status: 'ok', exit_code: 0, stdout, stderr: '' };
    } catch (err) {
      return {
        status: 'error',
        exit_code: err.status || -1,
        stdout: err.stdout?.toString() || '',
        stderr: err.stderr?.toString() || '',
        message: err.message,
      };
    }
  }
);

// 12. python_exec - Execute Python code
tools.python_exec = new Tool(
  {
    name: 'python_exec',
    description: 'Execute Python code in the sandbox.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Python source code.' },
        timeout_seconds: { type: 'integer', description: 'Optional timeout.' },
      },
      required: ['code'],
    },
  },
  async (params) => {
    const tmpFile = join(DATA_DIR, 'uploads', `script_${Date.now()}.py`);
    mkdirSync(dirname(tmpFile), { recursive: true });
    writeFileSync(tmpFile, params.code, 'utf-8');
    try {
      const opts = { timeout: (params.timeout_seconds || 30) * 1000, maxBuffer: 10 * 1024 * 1024 };
      const stdout = execSync(`python3 ${tmpFile}`, opts).toString();
      return { status: 'ok', stdout, stderr: '' };
    } catch (err) {
      return {
        status: 'error',
        stdout: err.stdout?.toString() || '',
        stderr: err.stderr?.toString() || '',
        message: err.message,
      };
    }
  }
);

// 13. create_pdf - Create PDF from HTML (basic)
tools.create_pdf = new Tool(
  {
    name: 'create_pdf',
    description: 'Create a PDF file from HTML content.',
    inputSchema: {
      type: 'object',
      properties: {
        html: { type: 'string', description: 'HTML content to convert.' },
        file_path: { type: 'string', description: 'Output path.' },
      },
      required: ['html', 'file_path'],
    },
  },
  async (params) => {
    const fullPath = join(__dirname, '..', '..', params.filePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    // Basic HTML-to-PDF via a simple text wrapper (for true PDF, integrate puppeteer/playwright)
    const pdfHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif;padding:2em;}</style></head><body>${params.html}</body></html>`;
    writeFileSync(fullPath, pdfHtml, 'utf-8');
    return { status: 'ok', file: `$[${params.filePath}]`, note: 'Saved as HTML. Install puppeteer for true PDF rendering.' };
  }
);

// 14. create_image - Generate placeholder images
tools.create_image = new Tool(
  {
    name: 'create_image',
    description: 'Generate images (placeholder SVG). For AI generation, connect an image API.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Image description.' },
        file_path: { type: 'string', description: 'Output path.' },
        aspect_ratio: { type: 'string', description: 'e.g. 1:1, 16:9' },
      },
      required: ['prompt', 'file_path'],
    },
  },
  async (params) => {
    const cleanPath = params.file_path.replace(/^\$?\[?\/?/, '/');
    const fullPath = join(__dirname, '..', '..', cleanPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    // Create an SVG placeholder with prompt text
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="#f0f0f0"/><text x="256" y="256" text-anchor="middle" font-size="16" fill="#666"><tspan x="256" dy="-20">Image generated from prompt:</tspan><tspan x="256" dy="24">${params.prompt.replace(/&/g,'&amp;').replace(/</g,'&lt;').slice(0,60)}</tspan></text></svg>`;
    writeFileSync(fullPath, svg, 'utf-8');
    return { status: 'ok', file: `$[${cleanPath}]`, note: 'SVG placeholder. Connect an AI image API for real generation.' };
  }
);

// 15. create_video - Placeholder
tools.create_video = new Tool(
  {
    name: 'create_video',
    description: 'Generate videos (placeholder).',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Video description.' },
        file_path: { type: 'string', description: 'Output path.' },
      },
      required: ['prompt', 'file_path'],
    },
  },
  async (params) => {
    return { status: 'ok', note: 'Video generation requires a connected API service. Placeholder accepted.' };
  }
);

// 16. sleep_until_next_trigger - Pause agent
tools.sleep = new Tool(
  {
    name: 'sleep_until_next_trigger',
    description: 'Pause the agent until the next external trigger or scheduled task.',
    inputSchema: { type: 'object', properties: {} },
  },
  async () => ({ status: 'ok', message: 'Agent paused until next trigger.' })
);

// 17. spawn_web_task - Browser automation (Playwright)
tools.spawn_web_task = new Tool(
  {
    name: 'spawn_web_task',
    description: 'Spawn a headless browser task using Playwright for web interactions.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Task description for the browser.' },
        requires_vision: { type: 'boolean', description: 'Whether the task needs visual/captcha capabilities.' },
      },
      required: ['prompt'],
    },
  },
  async (params) => {
    // For now, return a note that Playwright needs to be configured
    return {
      status: 'ok',
      task_id: uuidv4(),
      note: 'Browser automation task queued. Install playwright (`npx playwright install chromium`) and configure for full support.',
    };
  }
);

// ─── Export ────────────────────────────────────────────────────────────────

export function getTool(name) {
  return tools[name] || null;
}

export function getAllTools() {
  return Object.values(tools).map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

export async function executeTool(name, params, context) {
  const tool = tools[name];
  if (!tool) throw new Error(`Unknown tool: ${name}`);

  // Log to tool_results table
  const resultId = uuidv4();
  const db = context.db;

  try {
    const result = await tool.handler(params, context);

    // Log result
    db.prepare(`INSERT INTO tool_results (id, tool_name, params, result, created_at) VALUES (?, ?, ?, ?, datetime('now'))`)
      .run(resultId, name, JSON.stringify(params), JSON.stringify(result));

    return result;
  } catch (err) {
    db.prepare(`INSERT INTO tool_results (id, tool_name, params, result, created_at) VALUES (?, ?, ?, ?, datetime('now'))`)
      .run(resultId, name, JSON.stringify(params), JSON.stringify({ error: err.message }));

    throw err;
  }
}

export default { getTool, getAllTools, executeTool };
