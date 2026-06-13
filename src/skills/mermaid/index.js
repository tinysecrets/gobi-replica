import { execSync } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '..', '..', '..', 'data', 'exports');

/**
 * Render Mermaid diagram code to PNG using mermaid.ink API
 */
export async function renderMermaid(mermaidCode) {
  const encoded = Buffer.from(mermaidCode).toString('base64');
  const url = `https://mermaid.ink/img/${encoded}`;

  const response = await fetch(url, {
    headers: { 'User-Agent': 'GobiReplica/1.0' },
    timeout: 15000,
  });

  if (!response.ok) {
    throw new Error(`mermaid.ink returned ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const hash = crypto.createHash('md5').update(mermaidCode).digest('hex').slice(0, 8);
  const filePath = join(DATA_DIR, `mermaid_${hash}.png`);

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, buffer);

  return {
    status: 'success',
    file_path: `/data/exports/mermaid_${hash}.png`,
    url,
    bytes: buffer.length,
  };
}

/**
 * Parse and validate Mermaid diagram code
 */
export function validateMermaid(code) {
  const validTypes = [
    'graph', 'flowchart', 'sequenceDiagram', 'classDiagram',
    'stateDiagram', 'gantt', 'pie', 'erDiagram', 'journey',
    'mindmap', 'timeline', 'xychart',
  ];
  const firstWord = code.trim().split(/\s+/)[0];
  return validTypes.some(t => firstWord.startsWith(t));
}

export default { renderMermaid, validateMermaid };
