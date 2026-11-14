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
//   node usage-query.mjs --days 7 --tool-inputs --by tool   во что обходятся входы вызовов: генерация и перечитывание, оценка
//   node usage-query.mjs --search "кеш" --by thread   только ходы с фразой
//   node usage-query.mjs --project all --days 60 --by window --over 148,263   пятичасовые окна подписки и сколько из них дороже порогов
//   node usage-query.mjs --project all --days 60 --by week --week-start 2026-10-27T10:00   недели от сброса лимита и худшие 7 дней подряд
//   --project all       все проекты (по умолчанию — текущий)
//   --from 2026-09-05 --to 2026-09-11   свои границы вместо --days
//   --json              машинный вывод

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { cacheDir, emptyTotals, addTotals, fmtTokens, fmtUsd, missUsdOf, MISS_CAUSES, PRICES_CHECKED } from './usage-lib.mjs';
import { readArchive, mergeThreads } from './archive.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : argv[i + 1];
};
const has = (name) => argv.includes(name);

const BY = arg('--by', 'thread');
const TOP = Number(arg('--top', 0));
// Как в панели: переводы строк поиску не мешают, сообщения посреди хода ищутся вместе с ходом.
const flat = (s) => String(s).replace(/\s+/g, ' ').toLowerCase();
const said = (turn) => [turn.full || turn.text || '', ...(turn.followups || []).map((f) => f.full)].join(' ');
const SEARCH = flat(arg('--search', '')).trim();
const PROJECT = arg('--project', '');
const DAYS = arg('--days', '');
const FROM = arg('--from', '');
const TO = arg('--to', '');
const INPUTS = has('--tool-inputs');

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
function shape(t, missTokens, missUsd) {
  const think = t.output ? (t.usdOutput * t.thinking) / t.output : 0;
  return {
    'чтение кеша': [t.cacheRead, t.usdCacheRead],
    'запись кеша': [t.cacheWrite1h + t.cacheWrite5m, t.usdCacheWrite1h + t.usdCacheWrite5m],
    генерация: [t.output - t.thinking, t.usdOutput - think],
    размышления: [t.thinking, think],
    'свежий вход': [t.input, t.usdInput],
    'промахи кеша': [missTokens, missUsd],
  };
}

const emptyBucket = () => ({ totals: emptyTotals(), missTokens: 0, missUsd: 0, causes: {}, usd: 0, turns: 0, requests: 0, tools: {},
  inputs: { tokens: 0, usd: 0, rereadTokens: 0, rereadUsd: 0 } });

function bucketAdd(b, turn, tool) {
  addTotals(b.totals, turn.totals);
  b.missTokens += turn.missTokens || 0;
  b.missUsd += missUsdOf(turn.totals, turn.missTokens || 0);
  for (const [k, c] of Object.entries(turn.missCauses || {})) {
    const slot = (b.causes[k] ||= { count: 0, tokens: 0, usd: 0 });
    slot.count += c.count;
    slot.tokens += c.tokens;
    slot.usd += missUsdOf(turn.totals, c.tokens);
  }
  b.usd += turn.usd || 0;
  b.turns += 1;
  b.requests += turn.requests || 0;
  for (const [name, n] of Object.entries(turn.tools || {})) b.tools[name] = (b.tools[name] || 0) + n;
  // В разрезе по инструментам входы вызовов — только этого инструмента, в остальных — все.
  for (const [name, slot] of Object.entries(turn.toolInputs || {})) {
    if (tool && name !== tool) continue;
    for (const k of Object.keys(b.inputs)) b.inputs[k] += slot[k] || 0;
  }
}

const data = load();
const [from, to] = windowBounds();
const project = PROJECT === 'all' ? null : (PROJECT || data.current);

const groups = new Map();
const grand = emptyBucket();
const timed = [];
for (const thread of data.threads) {
  if (project && thread.project !== project) continue;
  const titleHit = SEARCH && flat(thread.title || '').includes(SEARCH);
  for (const turn of thread.turns) {
    const at = new Date(turn.at).getTime();
    if (!(at >= from && at <= to)) continue;
    if (SEARCH && !titleHit && !flat(said(turn)).includes(SEARCH)) continue;
    if (!turn.requests) continue;
    if (BY === 'window' || BY === 'week') { timed.push({ at, turn }); bucketAdd(grand, turn); continue; }

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
      bucketAdd(groups.get(k), turn, BY === 'tool' ? k : '');
    }
    bucketAdd(grand, turn);
  }
}

// Пятичасовое окно подписки открывает первый ход после конца прошлого. Недельное сбрасывается в закреплённое за
// аккаунтом время, которого журналы не знают: неделя отсчитывается от --week-start, по умолчанию с понедельника.
const two = (n) => String(n).padStart(2, '0');
const stamp = (ms) => { const d = new Date(ms); return `${two(d.getDate())}.${two(d.getMonth() + 1)} ${two(d.getHours())}:${two(d.getMinutes())}`; };
if (timed.length) {
  timed.sort((a, b) => a.at - b.at);
  const len = BY === 'window' ? 5 * 3600e3 : 7 * 86400e3;
  const anchor = new Date(arg('--week-start', '2026-01-05T00:00')).getTime();
  if (Number.isNaN(anchor)) {
    console.error('--week-start: нужна дата и время сброса недельного лимита, например 2026-10-27T10:00');
    process.exit(1);
  }
  let span = null;
  for (const { at, turn } of timed) {
    if (!span || at >= span.end) {
      const start = BY === 'window' ? at : anchor + Math.floor((at - anchor) / len) * len;
      span = { end: start + len, key: `${stamp(start)} – ${stamp(start + len)}` };
      groups.set(span.key, emptyBucket());
    }
    bucketAdd(groups.get(span.key), turn);
  }
}

const weight = (v) => (INPUTS ? v.inputs.usd + v.inputs.rereadUsd : v.usd);
// Окна и недели — по времени, свежие сверху, как дни.
const rows = timed.length ? [...groups.entries()].reverse()
  : [...groups.entries()].sort((a, b) => (BY === 'day' ? (a[0] < b[0] ? 1 : -1) : weight(b[1]) - weight(a[1])));
const shown = TOP ? rows.slice(0, TOP) : rows;

if (has('--json')) {
  // В конвейер вывод уходит частями: выходим, только когда он записан целиком, а дальше, к таблице, не идём.
  process.stdout.write(`${JSON.stringify({ by: BY, rows: shown.map(([k, v]) => ({ key: k, ...v })), total: grand }, null, 1)}\n`, () => process.exit(0));
  await new Promise(() => {});
}

const period = FROM || TO ? `${FROM || '…'} — ${TO || '…'}`
  : !DAYS || DAYS === 'all' ? 'всё время' : DAYS === '1' ? 'сегодня' : `${DAYS} дн.`;
console.log(`период: ${period} · проект: ${project ? (data.currentLabel || project) : 'все'}${SEARCH ? ` · поиск: «${SEARCH}»` : ''}`);
console.log(`итого: ${fmtUsd(grand.usd)} · ходов ${grand.turns} · запросов ${grand.requests}\n`);

// Имя треда бывает длиннее колонки — обрезается только оно, цифры никогда.
const pad = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s).padEnd(n));
const padL = (s, n) => String(s).padStart(n);
const width = Math.min(42, Math.max(12, ...shown.map(([k]) => k.length)));

if (INPUTS) {
  const row = (k, v) => `${pad(k, width)} ${padL(fmtTokens(Math.round(v.inputs.tokens)), 12)} ${padL(fmtUsd(v.inputs.usd), 11)} ${padL(fmtTokens(Math.round(v.inputs.rereadTokens)), 12)} ${padL(fmtUsd(v.inputs.rereadUsd), 14)}`;
  console.log(`${pad(BY, width)} ${padL('входы, ток.', 12)} ${padL('генерация', 11)} ${padL('перечитано', 12)} ${padL('перечитывание', 14)}`);
  for (const [k, v] of shown) console.log(row(k, v));
  console.log(row('ИТОГО', grand));
  console.log('\nоценка: клиент не сообщает, сколько токенов ушло на входы вызовов. Генерация запроса без размышлений делится между текстом ответа и входами по доле символов, перечитывание — те же токены в каждом следующем запросе треда по ставке чтения кэша.');
} else if (BY === 'tool') {
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
    console.log(`${pad(k, width)} ${padL(fmtTokens(v.missTokens), 13)} ${padL(fmtUsd(v.missUsd), 8)} ${padL(withMiss ? 'есть' : '—', 11)}`);
  }
  console.log(`\nвсего перезаписано ${fmtTokens(grand.missTokens)} = ${fmtUsd(grand.missUsd)} (ставка записи минус ставка чтения модели хода)`);
  // У ходов, собранных до разбора причин, причины нет: остаток назван отдельно, чтобы части сходились с целым.
  const causes = Object.entries(grand.causes).sort((a, b) => b[1].usd - a[1].usd);
  const rest = grand.missTokens - causes.reduce((s, [, c]) => s + c.tokens, 0);
  const parts = causes.map(([k, c]) => `${MISS_CAUSES[k] || k} — ${c.count} раз, ${fmtTokens(c.tokens)} = ${fmtUsd(c.usd)}`);
  if (rest > 0) parts.push(`причина не записана — ${fmtTokens(rest)}`);
  if (causes.length) console.log(`по причинам: ${parts.join('; ')}`);
} else {
  const articles = Object.keys(shape(emptyTotals(), 0));
  console.log(`${pad(BY, width)} ${padL('$', 9)} ${padL('ходов', 6)} ${articles.map((a) => padL(a, 15)).join('')}`);
  for (const [k, v] of shown) {
    const s = shape(v.totals, v.missTokens, v.missUsd);
    const cells = articles.map((a) => padL(`${fmtTokens(s[a][0])}/${fmtUsd(s[a][1])}`, 15)).join('');
    console.log(`${pad(k, width)} ${padL(fmtUsd(v.usd), 9)} ${padL(v.turns, 6)} ${cells}`);
  }
  const gs = shape(grand.totals, grand.missTokens, grand.missUsd);
  console.log(`${pad('ИТОГО', width)} ${padL(fmtUsd(grand.usd), 9)} ${padL(grand.turns, 6)} ${articles.map((a) => padL(`${fmtTokens(gs[a][0])}/${fmtUsd(gs[a][1])}`, 15)).join('')}`);
}

if (timed.length) {
  const sums = rows.map(([, v]) => v.usd).sort((a, b) => a - b);
  const share = (q) => fmtUsd(sums[Math.min(sums.length - 1, Math.floor(sums.length * q))]);
  const [topKey, top] = rows.reduce((m, r) => (r[1].usd > m[1].usd ? r : m));
  const over = String(arg('--over', '')).split(',').filter(Boolean).map((x) => `дороже $${x}: ${sums.filter((s) => s > Number(x)).length}`);
  console.log(`\n${BY === 'window' ? 'окон' : 'недель'} ${rows.length} · медиана ${share(0.5)} · 90 % не дороже ${share(0.9)} · самое дорогое ${fmtUsd(top.usd)} (${topKey})${over.map((s) => ` · ${s}`).join('')}`);
  if (BY === 'week') {
    const WEEK = 7 * 86400e3;
    let worst = { usd: 0, from: 0 };
    for (let i = 0, j = 0, sum = 0; i < timed.length; i++) {
      while (j < timed.length && timed[j].at < timed[i].at + WEEK) sum += timed[j++].turn.usd || 0;
      if (sum > worst.usd) worst = { usd: sum, from: timed[i].at };
      sum -= timed[i].turn.usd || 0;
    }
    console.log(`худшие 7 дней подряд: ${fmtUsd(worst.usd)} (${stamp(worst.from)} – ${stamp(worst.from + WEEK)})`);
  }
  if (project) console.log('лимиты подписки общие для всех проектов и машин, а здесь только один проект: для них нужен --project all');
}

console.log(`\nцены сверены ${PRICES_CHECKED}; промахи кеша входят в «запись кеша» и показаны отдельной статьёй.`);
