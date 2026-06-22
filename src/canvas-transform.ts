/**
 * Canvas Transform — converts markdown agent responses into styled HTML
 * for the ClaudeClaw Canvas (Telegram Mini App).
 *
 * Handles: bullet lists (including key:value auto-tabling), markdown tables,
 * code blocks, headings, bold/italic, numbered lists, and paragraphs.
 *
 * Also provides: marker extraction for explicit [CANVAS:...] directives,
 * and structured content stripping for Telegram chat summaries.
 */

// ── Types ────────────────────────────────────────────────────────────

export interface CanvasMarkerResult {
  text: string;
  payloads: CanvasPayloadInput[];
}

export interface CanvasPayloadInput {
  type: 'html' | 'markdown' | 'table' | 'chart' | 'clear';
  content: string;
  title?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function stripBold(s: string): string {
  return s.replace(/\*\*/g, '').trim();
}

function styleBold(s: string): string {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong style="color:#f1f5f9">$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');
}

function styleInline(s: string): string {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong style="color:#f1f5f9">$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.1);padding:2px 6px;border-radius:4px;font-size:12px">$1</code>');
}

// ── Shared styles ────────────────────────────────────────────────────

const TH_STYLE = 'padding:10px 14px;text-align:left;font-weight:600;font-size:14px;text-transform:uppercase;letter-spacing:0.5px;color:#94a3b8;border-bottom:2px solid #334155';
const TD_STYLE = 'padding:10px 14px;border-bottom:1px solid #1e293b;font-size:16px';

// ── Extract [CANVAS:type|content] markers ────────────────────────────

export function extractCanvasMarkers(text: string): CanvasMarkerResult {
  const payloads: CanvasPayloadInput[] = [];
  const pattern = /\[CANVAS:(html|markdown|table|chart|clear)\|?([\s\S]*?)\]/g;

  const cleaned = text.replace(pattern, (_match, type: string, content: string) => {
    let title: string | undefined;
    let body = content;
    if (type !== 'clear') {
      const pipeIdx = content.indexOf('|');
      if (pipeIdx > 0 && pipeIdx < 60) {
        title = content.slice(0, pipeIdx).trim();
        body = content.slice(pipeIdx + 1);
      }
    }
    payloads.push({ type: type as CanvasPayloadInput['type'], content: body.trim(), title });
    return '';
  });

  return { text: cleaned.replace(/\n{3,}/g, '\n\n').trim(), payloads };
}

// ── Markdown → styled HTML ──────────────────────────────────────────

/**
 * Convert markdown text to styled HTML for canvas rendering.
 * Returns null if the response doesn't contain structured content
 * worth rendering (tables, key:value lists, code blocks).
 * Plain text responses pass through without canvas rendering.
 */
export function markdownToCanvasHtml(text: string): string | null {
  if (!text || text.length < 80) return null;

  // Only render to canvas if there's actual structured content.
  // Plain text answers don't need the canvas treatment.
  const hasTable = /\|.+\|/.test(text) && (text.match(/\|/g) || []).length >= 6;
  const hasCodeBlock = /```[\s\S]+?```/.test(text);
  const bulletLines = (text.match(/^\s*[-*]\s+.+:.+$/gm) || []);
  const hasKvList = bulletLines.length >= 3;
  const hasList = (text.match(/^\s*[-*]\s+/gm) || []).length >= 5;
  const hasNumberedList = (text.match(/^\s*\d+[.)]\s+/gm) || []).length >= 5;

  if (!hasTable && !hasCodeBlock && !hasKvList && !hasList && !hasNumberedList) {
    return null;
  }

  const lines = text.split('\n');
  const htmlParts: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code blocks
    if (line.trimStart().startsWith('```')) {
      const lang = line.trim().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      htmlParts.push(renderCodeBlock(codeLines.join('\n'), lang));
      continue;
    }

    // Markdown table (pipe-delimited)
    if (line.includes('|') && line.trim().startsWith('|')) {
      const tableRows: string[] = [line];
      i++;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim().startsWith('|')) {
        tableRows.push(lines[i]);
        i++;
      }
      if (tableRows.length >= 2) {
        htmlParts.push(renderMarkdownTable(tableRows));
        continue;
      }
    }

    // Heading
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const sizes = ['', '26px', '22px', '18px', '16px'];
      htmlParts.push(`<div style="font-size:${sizes[headingMatch[1].length]};font-weight:700;margin:16px 0 8px;color:#f1f5f9">${esc(headingMatch[2])}</div>`);
      i++;
      continue;
    }

    // Bullet list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      htmlParts.push(renderBulletList(items));
      continue;
    }

    // Numbered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
        i++;
      }
      htmlParts.push(renderNumberedList(items));
      continue;
    }

    // Empty line
    if (line.trim() === '') { i++; continue; }

    // Regular paragraph
    htmlParts.push(`<p style="margin:10px 0;line-height:1.7;font-size:17px">${styleInline(line)}</p>`);
    i++;
  }

  if (htmlParts.length === 0) return null;

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:17px;color:#cbd5e1;padding:20px;max-width:100%">${htmlParts.join('')}</div>`;
}

// ── Renderers for specific content types ────────────────────────────

function renderCodeBlock(code: string, lang: string): string {
  return `<div style="margin:12px 0;border-radius:8px;overflow:hidden">` +
    (lang ? `<div style="background:#2d2d2d;color:#999;padding:4px 12px;font-size:11px;text-transform:uppercase">${esc(lang)}</div>` : '') +
    `<pre style="margin:0;padding:12px;background:#1e1e1e;color:#d4d4d4;font-size:15px;font-family:'SF Mono','Fira Code',monospace;overflow-x:auto;line-height:1.5">${esc(code)}</pre></div>`;
}

function renderMarkdownTable(rows: string[]): string {
  const parseCells = (row: string) => row.split('|').map(c => c.trim()).filter(c => c.length > 0);
  const headerCells = parseCells(rows[0]);
  const startIdx = (rows.length > 2 && /^[\s|:-]+$/.test(rows[1].replace(/\|/g, '').replace(/[-: ]/g, ''))) ? 2 : 1;
  const bodyRows = rows.slice(startIdx).map(parseCells);

  const ths = headerCells.map(h => `<th style="${TH_STYLE}">${esc(h)}</th>`).join('');
  const trs = bodyRows.map((cells, idx) => {
    const bg = idx % 2 === 0 ? '' : 'background:rgba(255,255,255,0.03)';
    return `<tr style="${bg}">${cells.map(c => `<td style="${TD_STYLE}">${esc(c)}</td>`).join('')}</tr>`;
  }).join('');

  return `<div style="margin:12px 0;border-radius:8px;overflow:hidden;border:1px solid #1e293b">` +
    `<table style="width:100%;border-collapse:collapse;font-size:16px"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`;
}

function renderBulletList(items: string[]): string {
  // Detect key:value pattern — render as table if most items match
  const kvItems = items.map(item => {
    const clean = stripBold(item);
    const m = clean.match(/^([^:]+?):\s*(.+)$/);
    return m ? { key: m[1].trim(), value: m[2].trim() } : null;
  });
  const kvCount = kvItems.filter(Boolean).length;

  if (kvCount >= 3 && kvCount >= items.length * 0.7) {
    return renderKvTable(kvItems.filter(Boolean) as Array<{ key: string; value: string }>);
  }

  // Regular styled list
  const lis = items.map(item =>
    `<li style="padding:10px 14px;border-bottom:1px solid rgba(255,255,255,0.05);font-size:16px">${styleBold(item)}</li>`
  ).join('');
  return `<ul style="list-style:none;padding:0;margin:12px 0;background:rgba(255,255,255,0.03);border-radius:8px;overflow:hidden">${lis}</ul>`;
}

function renderKvTable(kvItems: Array<{ key: string; value: string }>): string {
  // Split values on comma for multi-column if most items have commas
  const hasComma = kvItems.filter(kv => kv.value.includes(',')).length >= kvItems.length * 0.5;

  let tableHtml: string;
  if (hasComma) {
    const trs = kvItems.map((kv, idx) => {
      const bg = idx % 2 === 0 ? '' : 'background:rgba(255,255,255,0.03)';
      const parts = kv.value.split(',').map(p => p.trim());
      return `<tr style="${bg}"><td style="${TD_STYLE}"><strong style="color:#f1f5f9">${esc(kv.key)}</strong></td><td style="${TD_STYLE}">${esc(parts[0])}</td><td style="${TD_STYLE}">${esc(parts.slice(1).join(', '))}</td></tr>`;
    }).join('');
    tableHtml = `<tbody>${trs}</tbody>`;
  } else {
    const trs = kvItems.map((kv, idx) => {
      const bg = idx % 2 === 0 ? '' : 'background:rgba(255,255,255,0.03)';
      return `<tr style="${bg}"><td style="${TD_STYLE}"><strong style="color:#f1f5f9">${esc(kv.key)}</strong></td><td style="${TD_STYLE}">${esc(kv.value)}</td></tr>`;
    }).join('');
    tableHtml = `<tbody>${trs}</tbody>`;
  }

  return `<div style="margin:12px 0;border-radius:8px;overflow:hidden;border:1px solid #1e293b">` +
    `<table style="width:100%;border-collapse:collapse;font-size:16px">${tableHtml}</table></div>`;
}

function renderNumberedList(items: string[]): string {
  const lis = items.map((item, idx) =>
    `<li style="padding:6px 12px;display:flex;gap:8px;border-bottom:1px solid rgba(255,255,255,0.05)"><span style="color:#60a5fa;font-weight:600;min-width:20px">${idx + 1}.</span><span>${styleBold(item)}</span></li>`
  ).join('');
  return `<ul style="list-style:none;padding:0;margin:12px 0;background:rgba(255,255,255,0.03);border-radius:8px;overflow:hidden">${lis}</ul>`;
}

// ── Strip structured content for Telegram summary ───────────────────

/**
 * Remove structured content (lists, tables, code) from text, keeping
 * only summary paragraphs for the Telegram chat caption.
 */
export function stripStructuredContent(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trimStart().startsWith('```')) { i++; while (i < lines.length && !lines[i].trimStart().startsWith('```')) i++; i++; continue; }
    if (line.includes('|') && line.trim().startsWith('|')) { while (i < lines.length && lines[i].includes('|') && lines[i].trim().startsWith('|')) i++; continue; }
    if (/^\s*[-*]\s+/.test(line)) { while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) i++; continue; }
    if (/^\s*\d+[.)]\s+/.test(line)) { while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) i++; continue; }
    kept.push(line);
    i++;
  }

  const result = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return (!result || result.length < 20) ? 'Details in Canvas.' : result;
}
