#!/usr/bin/env node
// Builds the dashboard dataset from the session logs of every project.
// Output: dashboard.json next to the counter's other files.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  cacheDir, emptyTotals, addTotals, scanTranscript, sumModels, isRealRequest, normalizeModel, retention,
} from './usage-lib.mjs';
import { updateArchive } from './archive.mjs';

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const CONTEXT = { 'claude-haiku-4-5': 200000 };
const DEFAULT_CONTEXT = 1000000;
// Work stops not at the end of the window but where auto-compaction fires: about
// 967K for million-token models (docs: /docs/en/model-config), the window itself
// for the rest. That is the honest denominator for "how full is the table".
const COMPACT_AT = (size) => (size >= 1000000 ? 967000 : size);
const LEAD_LIMIT = 90;
const QUOTE_MIN = 30;

// The client wraps its own notes into the same text blocks as the user's words:
// IDE pointers, reminders, task notifications, skill preambles.
const NOISE_TAGS = /<(ide_[a-z_]+|system-reminder|task-notification|command-[a-z-]+|local-command-[a-z]+)>[\s\S]*?<\/\1>/g;
const SERVICE_PREFIX = /^(Stop hook feedback:|Base directory for this skill:|Caveat:|<command-name>)/;

function strip(text) {
  return text.replace(NOISE_TAGS, ' ').replace(/<\/?[a-z_-]+>/g, ' ').trim();
}

// A turn's caption: the first sentence of what the user actually wrote — quotes of
// my own previous answer are dropped, whether or not they carry ">".
export function caption(text, previousAnswer = '') {
  const body = strip(text).replace(/```[\s\S]*?```/g, ' ');
  const prev = previousAnswer.replace(/\s+/g, ' ');
  const own = body.split(/\n\s*\n/)
    .filter((p) => {
      const t = p.trim();
      if (t.startsWith('>')) return false;
      const flat = t.replace(/\s+/g, ' ');
      return !(flat.length > QUOTE_MIN && prev.includes(flat.slice(0, 60)));
    })
    .join(' ').replace(/\s+/g, ' ').trim();
  const clean = own || body.replace(/\s+/g, ' ').trim();
  const items = (body.match(/^\s*(?:[-*]|\d+[.)])\s+/gm) || []).length;
  const stop = clean.search(/[.!?](\s|$)/);
  let lead = stop > 20 ? clean.slice(0, stop + 1) : clean;
  if (lead.length > LEAD_LIMIT) {
    lead = lead.slice(0, LEAD_LIMIT);
    lead = `${lead.slice(0, Math.max(lead.lastIndexOf(' '), 40))}…`;
  }
  return items > 1 ? `${lead} (+${items} пунктов)` : lead;
}

// A user message can carry several text blocks: the client's note first, the
// person's words second — so all of them are joined before anything is decided.
function userText(rec) {
  const c = rec.message?.content;
  const raw = typeof c === 'string' ? c
    : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n\n') : '';
  if (!raw || SERVICE_PREFIX.test(raw.trim())) return '';
  return strip(raw) ? raw : '';
}

function assistantText(rec) {
  const c = rec.message?.content;
  if (!Array.isArray(c)) return '';
  return c.filter((b) => b.type === 'text').map((b) => b.text || '').join(' ');
}

const encodeProject = (dir) => dir.replace(/[\\/:]/g, '-').toLowerCase();

function newThread(project, id) {
  return {
    project, id, title: '', dir: '', firstAt: '', lastAt: '', requests: 0,
    table: 0, contextSize: DEFAULT_CONTEXT, model: '', effort: '',
    totals: emptyTotals(), missTokens: 0, turns: [],
  };
}

function readLog(file, thread, seen) {
  const text = fs.readFileSync(file, 'utf8');
  let turn = null;
  let lastAnswer = '';
  for (const line of text.split('\n')) {
    if (!line || line[0] !== '{') continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }

    if (rec.aiTitle) thread.title = rec.aiTitle;
    // The first cwd only: it is the folder the session started in, the one the
    // journal directory is named after. Later records follow the shell around
    // subdirectories and would rename the project after whatever was entered last.
    if (rec.cwd && !thread.dir) thread.dir = rec.cwd;

    if (rec.type === 'user') {
      const t = userText(rec);
      if (t) {
        turn = {

          at: rec.timestamp, text: caption(t, lastAnswer),
          // Whole message, uncut: the search runs over this field, and a cut here
          // makes it silently blind past the first paragraph.
          full: strip(t).replace(/\s+/g, ' '),
          usd: 0, requests: 0, model: '', effort: '', missTokens: 0, table: 0, totals: emptyTotals(),
          // Множители цены и разрезы отчёта: сама цена считается при разборе, но без
          // этих полей её потом нечем перепроверить и не по чему разложить.
          geo: '', speed: '', tier: '', client: '', branch: '', tools: {},
          contextSize: DEFAULT_CONTEXT, compactAt: COMPACT_AT(DEFAULT_CONTEXT),
        };
        thread.turns.push(turn);
      }
      continue;
    }

    if (rec.type === 'assistant') {
      const a = assistantText(rec);
      if (a) lastAnswer = a;
      // Чем занят ход: «на что ушли деньги» почти всегда упирается в инструменты.
      if (turn && Array.isArray(rec.message?.content)) {
        for (const b of rec.message.content) {
          if (b.type === 'tool_use' && b.name) turn.tools[b.name] = (turn.tools[b.name] || 0) + 1;
        }
      }
    }
    if (!isRealRequest(rec)) continue;

    const before = thread.missTokens || 0;
    const one = {};
    scanTranscript(line, seen, one, thread);
    const priced = one[normalizeModel(rec.message.model)];
    if (!priced) continue;
    const miss = (thread.missTokens || 0) - before;

    addTotals(thread.totals, priced);
    thread.requests += 1;
    thread.lastAt = rec.timestamp || thread.lastAt;
    thread.firstAt ||= rec.timestamp || '';
    thread.model = rec.message.model || thread.model;
    thread.effort = rec.effort || thread.effort;
    thread.contextSize = CONTEXT[normalizeModel(rec.message.model)] || DEFAULT_CONTEXT;
    thread.compactAt = COMPACT_AT(thread.contextSize);
    const u = rec.message.usage;
    thread.table = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);

    // Every request belongs to a turn, so a period cuts by the exact timestamp of
    // the request rather than by whole days. Requests that arrive before the first
    // user message (session bootstrap) get a turn of their own.
    if (!turn) {
      turn = {
        at: rec.timestamp, text: '(служебные запросы)', full: '', service: true,
        usd: 0, requests: 0, model: '', effort: '', missTokens: 0, table: 0, totals: emptyTotals(),
        geo: '', speed: '', tier: '', client: '', branch: '', tools: {},
        contextSize: DEFAULT_CONTEXT, compactAt: COMPACT_AT(DEFAULT_CONTEXT),
      };
      thread.turns.push(turn);
    }
    addTotals(turn.totals, priced);
    // Not a sum but a state: how full the table was at this point of the thread,
    // so the last request of the turn is the one that dates it.
    turn.table = thread.table;
    turn.usd += priced.usd;
    turn.requests += 1;
    turn.missTokens += miss;
    turn.model = rec.message.model || turn.model;
    turn.effort = rec.effort || turn.effort;
    turn.geo = u.inference_geo || turn.geo;
    turn.speed = u.speed || turn.speed;
    turn.tier = u.service_tier || turn.tier;
    turn.client = rec.version || turn.client;
    turn.branch = rec.gitBranch || turn.branch;
    // Окно у каждой модели своё, а модель может смениться посреди треда: знаменатель
    // «стола» принадлежит ходу, а не треду целиком.
    turn.contextSize = thread.contextSize;
    turn.compactAt = thread.compactAt;
  }
}

function build(currentDir) {
  const threads = [];
  const current = path.basename(currentDir);
  for (const project of fs.readdirSync(PROJECTS)) {
    const dir = path.join(PROJECTS, project);
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries.filter((n) => n.endsWith('.jsonl'))) {
      const thread = newThread(project, name.slice(0, -6));
      try { readLog(path.join(dir, name), thread, new Set()); } catch { continue; }
      if (thread.requests) threads.push(thread);
    }
  }
  threads.sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
  // A project is named by its own root, not by whichever folder a session wandered
  // into: the journal directory name is the root path with separators replaced, so
  // the cwd that encodes back to it is the root. Threads of one project share it.
  const roots = new Map();
  for (const t of threads) {
    if (!t.dir || roots.get(t.project)) continue;
    if (encodeProject(t.dir) === t.project.toLowerCase()) roots.set(t.project, t.dir);
  }
  const label = (project, dir) => {
    const root = roots.get(project) || dir;
    return root ? path.basename(root) : project;
  };
  return {
    generatedAt: new Date().toISOString(),
    current,
    currentLabel: label(current, (threads.find((t) => t.project === current) || {}).dir),
    threads: threads.map((t) => ({
      ...t, usd: sumModels({ x: t.totals }).usd, projectLabel: label(t.project, t.dir),
    })),
  };
}

let currentCwd = '';

async function projectDir() {
  const flag = process.argv.indexOf('--dir');
  if (flag !== -1) return process.argv[flag + 1];
  const chunks = [];
  try {
    for await (const c of process.stdin) chunks.push(c);
  } catch { /* no stdin */ }
  const raw = Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '');
  try {
    const d = JSON.parse(raw);
    currentCwd = d.cwd || '';
    if (d.transcript_path) return path.dirname(d.transcript_path);
  } catch { /* not a hook call */ }
  return null;
}

const dir = await projectDir();
if (!dir || !fs.existsSync(dir)) {
  process.stdout.write(`не указана папка проекта: передай --dir <папка в ${PROJECTS}> или подай JSON хука на stdin\n`);
  process.exit(1);
}
const dir2 = cacheDir();
// Служебные файлы состояния копятся сами по себе; чистка идёт не чаще раза в сутки
// и не трогает каталоги, поэтому архив её переживает.
try { retention(dir2); } catch { /* чистка не должна ронять сбор данных */ }
const out = path.join(dir2, 'dashboard.json');
const data = build(dir);
// The hook's cwd follows the shell into subfolders, so it names the project only
// when the journals gave no root of their own.
if (currentCwd && !data.currentLabel) data.currentLabel = path.basename(currentCwd);
fs.writeFileSync(out, JSON.stringify(data));
// The window is what the journals still hold; the archive is what stays after they
// are wiped. --no-archive is for test runs that must not touch the store.
const stats = process.argv.includes('--no-archive') ? null : updateArchive(data);
if (process.argv.includes('--print')) {
  const usd = data.threads.reduce((a, t) => a + t.usd, 0);
  console.log(`проект ${data.currentLabel} · тредов ${data.threads.length} · ходов ${data.threads.reduce((a, t) => a + t.turns.length, 0)} · $${usd.toFixed(2)}`);
  if (stats) {
    console.log(`архив: месяцев ${stats.months} (переписано ${stats.written}) · тредов ${stats.threads} · ходов ${stats.turns} · ${(stats.bytes / 1024).toFixed(0)} КБ`);
  }
  for (const t of data.threads.slice(0, 3)) {
    console.log(`  ${t.projectLabel} · ${t.title || t.id.slice(0, 8)} · $${t.usd.toFixed(2)} · запросов ${t.requests}`);
    for (const turn of t.turns.slice(0, 2)) console.log(`      ${turn.at.slice(5, 16)} $${turn.usd.toFixed(2)} «${turn.text}»`);
  }
}
