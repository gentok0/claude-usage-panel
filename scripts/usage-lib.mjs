// Shared token/price logic for the status line and the summary report.
// Prices: https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-09-11).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const OPUS = { in: 5, w5m: 6.25, w1h: 10, read: 0.5, out: 25 };
const OPUS_FAST = { in: 10, w5m: 12.5, w1h: 20, read: 1, out: 50 };
const FABLE_51 = { in: 10, w5m: 12.5, w1h: 20, read: 0.25, out: 50 };
const FABLE_5 = { in: 10, w5m: 12.5, w1h: 20, read: 1, out: 50 };

export const PRICES = {
  'claude-opus-5': { ...OPUS, fast: OPUS_FAST },
  'claude-opus-4-8': { ...OPUS, fast: OPUS_FAST },
  'claude-opus-4-7': OPUS,
  'claude-opus-4-6': OPUS,
  'claude-opus-4-5': OPUS,
  'claude-fable-5-1': FABLE_51,
  'claude-mythos-5-1': FABLE_51,
  'claude-fable-5': FABLE_5,
  'claude-mythos-5': FABLE_5,
  'claude-sonnet-5': { in: 2, w5m: 2.5, w1h: 4, read: 0.2, out: 10 },
  'claude-sonnet-4-6': { in: 3, w5m: 3.75, w1h: 6, read: 0.3, out: 15 },
  'claude-sonnet-4-5': { in: 3, w5m: 3.75, w1h: 6, read: 0.3, out: 15 },
  'claude-haiku-4-5': { in: 1, w5m: 1.25, w1h: 2, read: 0.1, out: 5 },
};

export const WEB_SEARCH_USD = 0.01; // $10 per 1000 searches
export const PRICES_CHECKED = '2026-09-11';

// Claude Code logs local operations as "<synthetic>" records with empty usage:
// they are not requests and must not become the model, the table or the last turn.
export function isRealRequest(rec) {
  const u = rec?.message?.usage;
  if (!u || rec.message.model === '<synthetic>') return false;
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
    + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0) > 0;
}

// "claude-opus-5[1m]", "claude-opus-5-20260401" -> "claude-opus-5"
export function normalizeModel(id) {
  if (!id) return 'unknown';
  return String(id)
    .toLowerCase()
    .replace(/\[.*?\]/g, '')
    .replace(/-\d{8}$/, '')
    .trim();
}

export function emptyTotals() {
  return {
    input: 0,
    cacheRead: 0,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    output: 0,
    thinking: 0,
    webSearch: 0,
    requests: 0,
    usd: 0,
    usdInput: 0,
    usdCacheRead: 0,
    usdCacheWrite1h: 0,
    usdCacheWrite5m: 0,
    usdOutput: 0,
    usdWebSearch: 0,
  };
}

export function addTotals(a, b) {
  for (const k of Object.keys(a)) a[k] += b[k] || 0;
  return a;
}

// One transcript record -> per-request totals with price applied.
function priceRecord(usage, model) {
  const key = normalizeModel(model);
  const base = PRICES[key];
  const fast = usage.speed === 'fast';
  const p = base ? (fast && base.fast ? base.fast : base) : null;
  const geo = usage.inference_geo === 'us' ? 1.1 : 1;

  const cc = usage.cache_creation || {};
  const w1h = cc.ephemeral_1h_input_tokens ?? 0;
  const w5m = cc.ephemeral_5m_input_tokens ?? 0;
  // Older records carry only the combined field; treat it as 5m when unsplit.
  const wTotal = usage.cache_creation_input_tokens ?? 0;
  const w5mFinal = w1h + w5m === 0 ? wTotal : w5m;

  const t = {
    input: usage.input_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite1h: w1h,
    cacheWrite5m: w5mFinal,
    output: usage.output_tokens ?? 0,
    thinking: usage.output_tokens_details?.thinking_tokens ?? 0,
    webSearch: usage.server_tool_use?.web_search_requests ?? 0,
    requests: 1,
    usd: 0,
    usdInput: 0,
    usdCacheRead: 0,
    usdCacheWrite1h: 0,
    usdCacheWrite5m: 0,
    usdOutput: 0,
    usdWebSearch: 0,
  };

  if (p) {
    const rate = (tokens, price) => (geo * tokens * price) / 1e6;
    t.usdInput = rate(t.input, p.in);
    t.usdCacheRead = rate(t.cacheRead, p.read);
    t.usdCacheWrite1h = rate(t.cacheWrite1h, p.w1h);
    t.usdCacheWrite5m = rate(t.cacheWrite5m, p.w5m);
    t.usdOutput = rate(t.output, p.out);
  }
  t.usdWebSearch = t.webSearch * WEB_SEARCH_USD;
  t.usd =
    t.usdInput +
    t.usdCacheRead +
    t.usdCacheWrite1h +
    t.usdCacheWrite5m +
    t.usdOutput +
    t.usdWebSearch;
  return t;
}

// Claude Code counts a request as a cache miss when it re-processed more than 5%
// and at least 2000 tokens of what it could have read from cache (docs: /docs/en/costs).
const MISS_SHARE = 0.05;
const MISS_MIN_TOKENS = 2000;

export function missCheck(prevTable, usage) {
  const couldRead = prevTable;
  if (!couldRead) return 0;
  const shortfall = couldRead - (usage.cache_read_input_tokens ?? 0);
  if (shortfall < MISS_MIN_TOKENS || shortfall < couldRead * MISS_SHARE) return 0;
  return usage.cache_creation_input_tokens ?? 0;
}

export function tableSize(usage) {
  return (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
}

// Scan JSONL text, deduplicating by requestId; seen is a Set carried across calls.
// Returns the last priced record so callers can show the cost of one request.
export function scanTranscript(text, seen, byModel, ctx) {
  let last = null;
  for (const line of text.split('\n')) {
    if (!line || line.charCodeAt(0) !== 123 /* { */) continue;
    if (!line.includes('"usage"')) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRealRequest(rec)) continue;
    const usage = rec.message.usage;
    const id = rec.requestId || rec.uuid;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const model = normalizeModel(rec.message.model);
    if (!byModel[model]) byModel[model] = emptyTotals();
    const priced = priceRecord(usage, rec.message.model);
    if (ctx) {
      priced.missTokens = missCheck(ctx.prevTable, usage);
      ctx.prevTable = tableSize(usage);
      ctx.missTokens = (ctx.missTokens || 0) + priced.missTokens;
    }
    addTotals(byModel[model], priced);
    last = priced;
  }
  return { byModel, last };
}

export function sumModels(byModel) {
  const out = emptyTotals();
  for (const m of Object.values(byModel)) addTotals(out, m);
  return out;
}

export function cacheDir() {
  const dir =
    process.env.CLAUDE_USAGE_DIR ||
    path.join(os.homedir(), '.claude', 'usage-counter');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Delete state files older than `days`; runs at most once per calendar day.
export function retention(dir, days = 14) {
  const stamp = path.join(dir, '.last-cleanup');
  const today = new Date().toISOString().slice(0, 10);
  try {
    if (fs.readFileSync(stamp, 'utf8').trim() === today) return;
  } catch {
    /* first run */
  }
  const cutoff = Date.now() - days * 86400e3;
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const p = path.join(dir, name);
    try {
      const st = fs.statSync(p);
      // Только собственные файлы состояния. Архив это каталог, и он живёт вечно:
      // он и есть копия, переживающая журналы.
      if (!st.isDirectory() && st.mtimeMs < cutoff) fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
  fs.writeFileSync(stamp, today);
}

export function fmtTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'K';
  return String(n);
}

export function fmtUsd(n) {
  return (
    '$' + (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2))
  );
}
