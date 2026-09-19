#!/usr/bin/env node
// Ответы на вопросы про траты: одна выборка, любой разрез. Данные те же, что у
// панели — окно из журналов плюс архив, — поэтому цифры сходятся с ней до цента.
//
// Примеры:
//   node usage-query.mjs --days 1                     сколько потрачено сегодня
//   node usage-query.mjs --days 7 --by day            расход по дням недели
//   node usage-query.mjs --days 30 --by model         разрез по моделям
//   node usage-query.mjs --by thread --top 5          самые дорогие треды
//   node usage-query.mjs --days 7 --by tool           чем занимались ходы
//   node usage-query.mjs --days 7 --misses            промахи кэша и их цена
//   node usage-query.mjs --search "кеш" --by thread   только ходы с фразой
//   --project all       все проекты (по умолчанию — текущий)
//   --from 2026-09-05 --to 2026-09-11   свои границы вместо --days
//   --json              машинный вывод

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { cacheDir, emptyTotals, addTotals, fmtTokens, fmtUsd, PRICES_CHECKED } from './usage-lib.mjs';
import { readArchive, mergeThreads } from './archive.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : argv[i + 1];
};
const has = (name) => argv.includes(name);

const BY = arg('--by', 'thread');
const TOP = Number(arg('--top', 0));
const SEARCH = String(arg('--search', '')).toLowerCase();
const PROJECT = arg('--project', '');
const DAYS = arg('--days', '');
const FROM = arg('--from', '');
const TO = arg('--to', '');

// Календарные сутки по местному времени — «день» у человека начинается в полночь,
// а не 24 часа назад.
const dayKey = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
function windowBounds() {
  if (FROM || TO) {
    const from = FROM ? new Date(`${FROM}T00:00:00`).getTime() : 0;
    const to = TO ? new Date(`${TO}T23:59:59.999`).getTime() : Infinity;
    return [from, to];
  }
  if (!DAYS || DAYS === 'all') return [0, Infinity];
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return [d.getTime() - (Number(DAYS) - 1) * 86400e3, Infinity];
}

function load() {
  let live = { threads: [], current: '', currentLabel: '' };
  try { live = JSON.parse(fs.readFileSync(path.join(cacheDir(), 'dashboard.json'), 'utf8')); } catch { /* нет окна */ }
  let archive = [];
  try { archive = readArchive(); } catch { /* нет архива */ }
  return { ...live, threads: mergeThreads([...archive, ...live.threads]) };
}

// Статьи в том же составе и с теми же именами, что в панели.
function shape(t, missTokens) {
  const think = t.output ? (t.usdOutput * t.thinking) / t.output : 0;
  return {
    'чтение кеша': [t.cacheRead, t.usdCacheRead],
    'запись кеша': [t.cacheWrite1h + t.cacheWrite5m, t.usdCacheWrite1h + t.usdCacheWrite5m],
    генерация: [t.output - t.thinking, t.usdOutput - think],
    размышления: [t.thinking, think],
    'свежий вход': [t.input, t.usdInput],
    'промахи кеша': [missTokens, (missTokens * (10 - 0.5)) / 1e6],
  };
}

const emptyBucket = () => ({ totals: emptyTotals(), missTokens: 0, usd: 0, turns: 0, requests: 0, tools: {} });

function bucketAdd(b, turn) {
  addTotals(b.totals, turn.totals);
  b.missTokens += turn.missTokens || 0;
  b.usd += turn.usd || 0;
  b.turns += 1;
  b.requests += turn.requests || 0;
  for (const [name, n] of Object.entries(turn.tools || {})) b.tools[name] = (b.tools[name] || 0) + n;
}

const data = load();
const [from, to] = windowBounds();
const project = PROJECT === 'all' ? null : (PROJECT || data.current);

const groups = new Map();
const grand = emptyBucket();
for (const thread of data.threads) {
  if (project && thread.project !== project) continue;
  const titleHit = SEARCH && (thread.title || '').toLowerCase().includes(SEARCH);
  for (const turn of thread.turns) {
    const at = new Date(turn.at).getTime();
    if (!(at >= from && at <= to)) continue;
    if (SEARCH && !titleHit && !(turn.full || turn.text || '').toLowerCase().includes(SEARCH)) continue;
    if (!turn.requests) continue;

    // Ключ разреза. «Инструменты» раскладывают один ход по нескольким ключам, поэтому
    // считаются отдельно: приписывать ходу цену одного инструмента нельзя.
    let keys = [];
    if (BY === 'thread') keys = [thread.title || thread.turns[0]?.text || thread.id.slice(0, 8)];
    else if (BY === 'project') keys = [thread.projectLabel || thread.project];
    else if (BY === 'day') keys = [dayKey(turn.at)];
    else if (BY === 'model') keys = [(turn.model || thread.model || 'неизвестно').replace('claude-', '')];
    else if (BY === 'effort') keys = [turn.effort || 'неизвестно'];
    else if (BY === 'client') keys = [turn.client || 'неизвестно'];
    else if (BY === 'tool') keys = Object.keys(turn.tools || {});
    else keys = ['всё'];

    for (const k of keys) {
      if (!groups.has(k)) groups.set(k, emptyBucket());
      bucketAdd(groups.get(k), turn);
    }
    bucketAdd(grand, turn);
  }
}

const rows = [...groups.entries()].sort((a, b) => (BY === 'day' ? (a[0] < b[0] ? 1 : -1) : b[1].usd - a[1].usd));
const shown = TOP ? rows.slice(0, TOP) : rows;

if (has('--json')) {
  console.log(JSON.stringify({ by: BY, rows: shown.map(([k, v]) => ({ key: k, ...v })), total: grand }, null, 1));
  process.exit(0);
}

const period = FROM || TO ? `${FROM || '…'} — ${TO || '…'}`
  : !DAYS || DAYS === 'all' ? 'всё время' : DAYS === '1' ? 'сегодня' : `${DAYS} дн.`;
console.log(`период: ${period} · проект: ${project ? (data.currentLabel || project) : 'все'}${SEARCH ? ` · поиск: «${SEARCH}»` : ''}`);
console.log(`итого: ${fmtUsd(grand.usd)} · ходов ${grand.turns} · запросов ${grand.requests}\n`);

// Имя треда бывает длиннее колонки — обрезается только оно, цифры никогда.
const pad = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s).padEnd(n));
const padL = (s, n) => String(s).padStart(n);
const width = Math.min(42, Math.max(12, ...shown.map(([k]) => k.length)));

if (BY === 'tool') {
  // У инструмента нет своей цены: он не запрос. Честная единица — сколько раз вызван
  // и в скольких ходах встретился; деньги ходов показаны рядом как контекст.
  console.log(`${pad('инструмент', width)} ${padL('вызовов', 8)} ${padL('ходов', 7)} ${padL('$ этих ходов', 14)}`);
  for (const [k, v] of shown) {
    const calls = Object.values(v.tools).reduce((a, n) => a + n, 0);
    console.log(`${pad(k, width)} ${padL(calls, 8)} ${padL(v.turns, 7)} ${padL(fmtUsd(v.usd), 14)}`);
  }
  console.log('\nцена ходов — это полная цена, а не стоимость инструмента: в одном ходе их несколько.');
} else if (has('--misses')) {
  console.log(`${pad(BY, width)} ${padL('перезаписано', 13)} ${padL('цена', 8)} ${padL('доля ходов', 11)}`);
  for (const [k, v] of shown) {
    const withMiss = v.missTokens > 0 ? 1 : 0;
    console.log(`${pad(k, width)} ${padL(fmtTokens(v.missTokens), 13)} ${padL(fmtUsd((v.missTokens * 9.5) / 1e6), 8)} ${padL(withMiss ? 'есть' : '—', 11)}`);
  }
  console.log(`\nвсего перезаписано ${fmtTokens(grand.missTokens)} = ${fmtUsd((grand.missTokens * 9.5) / 1e6)} (ставка записи минус ставка чтения)`);
} else {
  const articles = Object.keys(shape(emptyTotals(), 0));
  console.log(`${pad(BY, width)} ${padL('$', 9)} ${padL('ходов', 6)} ${articles.map((a) => padL(a, 15)).join('')}`);
  for (const [k, v] of shown) {
    const s = shape(v.totals, v.missTokens);
    const cells = articles.map((a) => padL(`${fmtTokens(s[a][0])}/${fmtUsd(s[a][1])}`, 15)).join('');
    console.log(`${pad(k, width)} ${padL(fmtUsd(v.usd), 9)} ${padL(v.turns, 6)} ${cells}`);
  }
  const gs = shape(grand.totals, grand.missTokens);
  console.log(`${pad('ИТОГО', width)} ${padL(fmtUsd(grand.usd), 9)} ${padL(grand.turns, 6)} ${articles.map((a) => padL(`${fmtTokens(gs[a][0])}/${fmtUsd(gs[a][1])}`, 15)).join('')}`);
}

console.log(`\nцены сверены ${PRICES_CHECKED}; промахи кеша входят в «запись кеша» и показаны отдельной статьёй.`);
