#!/usr/bin/env node
// Builds the dashboard dataset from the session logs of every project.
// Output: dashboard.json next to the counter's other files.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  cacheDir, emptyTotals, addTotals, scanTranscript, sumModels, isRealRequest, normalizeModel,
  priceRecord, PRICES, senderMarks, sentByPerson, namesJournalDir,
} from './usage-lib.mjs';
import { updateArchive, writeAtomic } from './archive.mjs';
import { attachmentsOf, saveAttachments } from './attachments.mjs';

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
// The window is what the journals still hold; the archive is what stays after they
// are wiped. --no-archive is for test runs that must not touch the store.
const STORE = !process.argv.includes('--no-archive');
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
// Часть записей от лица человека пишет сам клиент. Если считать их ходами, разговор рвётся —
// подпись остаётся в одной строке, деньги уходят в другую. Ход открывает только сообщение
// с пометкой «прислал человек» (sentByPerson), а этот перечень решает лишь в журналах без пометок.
// За прерыванием и продолжением не стоит ни одного запроса к модели, за раскрытой слэш-командой
// стоят — её отсекать нельзя.
const SERVICE_PREFIX = /^(Stop hook feedback:|Base directory for this skill:|Caveat:|<command-name>|\[Image: source:|\[Image: original|\[Request interrupted|Continue from where you left off)/;

// Вставленный текст клиент оборачивает тегом с атрибутом: обёртку снимаем, сам текст — слова человека.
const PASTE_WRAP = /<\/?pasted_content\b[^>]*>/g;

function strip(text) {
  return text.replace(NOISE_TAGS, ' ').replace(PASTE_WRAP, ' ').replace(/<\/?[a-z_-]+>/g, ' ').trim();
}

// The message as the person wrote it: line breaks and paragraphs stay, only runs of
// spaces and empty lines are squeezed.
const tidy = (text) => text.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ')
  .replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

const blocksText = (c) => (typeof c === 'string' ? c
  : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n\n') : '');

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
  const raw = blocksText(rec.message?.content);
  if (!raw || SERVICE_PREFIX.test(raw.trim())) return '';
  return strip(raw) ? raw : '';
}

// A typed slash command is the person's message, though all its text sits inside the client's tags.
const commandOf = (rec) => blocksText(rec.message?.content).match(/<command-name>([^<]+)<\/command-name>/)?.[1].trim() || '';

function assistantText(rec) {
  const c = rec.message?.content;
  if (!Array.isArray(c)) return '';
  return c.filter((b) => b.type === 'text').map((b) => b.text || '').join(' ');
}


function newThread(project, id) {
  return {
    project, id, title: '', dir: '', firstAt: '', lastAt: '', requests: 0,
    table: 0, contextSize: DEFAULT_CONTEXT, model: '', effort: '',
    totals: emptyTotals(), missTokens: 0, turns: [],
  };
}

// Почему запрос не прочитал кэш. Сервер у длинной переписки почти всегда отвечает «unavailable», поэтому причина
// собирается из журнала: модель, пауза до запроса и что клиент отправил заново. Клиент записывает каждый запрос:
// сколько сообщений прошлого он оставил как было (keep) и что отправил после них (tail).
const HOUR = 3600e3;
const FIVE_MINUTES = 300e3;
// Картинку, вырезанную из старой переписки, клиент заменяет текстом с этим началом.
const MEDIA_CUT = '[media removed';
const cutText = (b) => b?.type === 'text' && String(b.text || '').startsWith(MEDIA_CUT);
const cutsMedia = (message) => (Array.isArray(message?.content) ? message.content : [])
  .some((b) => cutText(b) || (b.type === 'tool_result' && Array.isArray(b.content) && b.content.some(cutText)));

function missCause(rec, prev, sent, cut) {
  const said = rec.message.diagnostics?.cache_miss_reason?.type;
  if (said === 'model_changed' || (prev && prev.model !== normalizeModel(rec.message.model))) return 'model';
  const req = sent.get(rec.requestRef);
  const at = req ? req.at : Date.parse(rec.timestamp);
  if (said === 'previous_message_not_found' || (prev && at - prev.at > prev.ttl)) return prev?.ttl === HOUR ? 'pause-1h' : 'pause-5m';
  const before = req && sent.get(req.base);
  if (before && req.keep < before.keep + before.tail.length) return req.tail.some((h) => cut.has(h)) ? 'media' : 'history';
  if (said === 'system_changed' || said === 'tools_changed') return 'setup';
  return said === 'messages_changed' ? 'history' : 'unknown';
}

function readLog(file, thread, seen, unpriced) {
  const text = fs.readFileSync(file, 'utf8');
  const marks = senderMarks(text);
  let turn = null;
  // Запросы клиента и вырезанные им картинки — для причины промаха; prev — прошлый запрос к модели.
  const sent = new Map();
  const cut = new Set();
  let prev = null;
  let lastAnswer = '';
  let lastPrompt = '';
  let named = '';
  const events = new Set();
  const asks = new Map();
  for (const line of text.split('\n')) {
    if (!line || line[0] !== '{') continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    // Клиент изредка дописывает повтор уже записанной истории теми же записями — это не новые ходы.
    if (rec.uuid && events.has(rec.uuid)) continue;
    if (rec.uuid) events.add(rec.uuid);

    // Имя, данное треду при запуске или переименовании, VS Code ставит выше придуманного клиентом — панель так же.
    if (rec.customTitle) named = rec.customTitle;
    if (rec.aiTitle) thread.title = rec.aiTitle;
    // Под чьим входом шла работа: по организации ход потом находит строку входа.
    if (rec.attachment?.type === 'credential_org') (thread.orgs ||= []).push({ at: rec.timestamp, org: rec.attachment.organizationUuid });
    // A thread the client never named it labels with the last message; the panel does the same.
    if (rec.type === 'last-prompt' && rec.lastPrompt) lastPrompt = rec.lastPrompt;
    // The first cwd only: it is the folder the session started in, the one the
    // journal directory is named after. Later records follow the shell around
    // subdirectories and would rename the project after whatever was entered last.
    if (rec.cwd && !thread.dir) thread.dir = rec.cwd;
    if (rec.type === 'api-request') { sent.set(rec.id, { at: Date.parse(rec.timestamp), base: rec.base, keep: rec.keep ?? 0, tail: rec.tail || [] }); continue; }
    if (rec.type === 'api-request-blob') { if (cutsMedia(rec.message)) cut.add(rec.hash); continue; }

    // A message sent while the model is still working does not open a turn: the
    // client folds it into the running one, and the requests after it stay there.
    // The same record type carries the client's own background-task notices.
    const queued = rec.type === 'attachment' ? rec.attachment : null;
    if (queued?.type === 'queued_command') {
      const human = queued.commandMode === 'prompt' && (!queued.origin || queued.origin.kind === 'human');
      if (human && turn) {
        const at = rec.timestamp || queued.timestamp;
        const said = tidy(strip(blocksText(queued.prompt)));
        const files = saveAttachments(thread.id, at, attachmentsOf(queued.prompt), STORE);
        if (said || files.length) (turn.followups ||= []).push({ at, full: said, ...(files.length ? { files } : {}) });
      }
      continue;
    }

    if (rec.type === 'user') {
      // The text of a skill or command the client inserts on my call points at that call:
      // it is not the person's words and opens no turn.
      if (rec.sourceToolUseID) continue;
      const person = sentByPerson(rec, marks);
      const t = person === false ? '' : userText(rec) || (person ? commandOf(rec) : '');
      const files = rec.isMeta ? [] : saveAttachments(thread.id, rec.timestamp, attachmentsOf(rec.message?.content), STORE);
      // A picture sent without words opens no turn, so it stays with the running one,
      // the same one its requests go to.
      if (!t && files.length && turn) (turn.files ||= []).push(...files);
      if (t) {
        turn = {
          ...(files.length ? { files } : {}),
          at: rec.timestamp, text: caption(t, lastAnswer),
          // Whole message, uncut: the search runs over this field, and a cut here
          // makes it silently blind past the first paragraph.
          full: tidy(strip(t)),
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
      // Чем занят ход: «на что ушли деньги» почти всегда упирается в инструменты. Ответ пишется по блоку
      // на запись, поэтому символы текста и входов вызовов копятся по запросу со всех его записей.
      if (Array.isArray(rec.message?.content)) {
        const id = rec.requestId || rec.uuid;
        const ask = asks.get(id) || { text: 0, tools: {} };
        asks.set(id, ask);
        for (const b of rec.message.content) {
          if (b.type === 'text') ask.text += (b.text || '').length;
          if (b.type !== 'tool_use' || !b.name) continue;
          if (turn) turn.tools[b.name] = (turn.tools[b.name] || 0) + 1;
          ask.tools[b.name] = (ask.tools[b.name] || 0) + JSON.stringify(b.input ?? {}).length;
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
    // Кому клиент относит запрос: хранится для анализа трат, панель это не рисует.
    for (const [field, name] of [['skills', rec.attributionSkill], ['plugins', rec.attributionPlugin]]) {
      if (!name) continue;
      const slot = ((turn[field] ||= {})[name] ||= { requests: 0, usd: 0 });
      slot.requests += 1;
      slot.usd += priced.usd;
    }
    turn.missTokens += miss;
    // Причины промахов хода панель показывает подсказкой у промаха запроса.
    if (miss) {
      const slot = ((turn.missCauses ||= {})[missCause(rec, prev, sent, cut)] ||= { count: 0, tokens: 0 });
      slot.count += 1;
      slot.tokens += miss;
    }
    // Срок кэша задаёт последняя запись: чтение продлевает его, не меняя.
    const ttl = u.cache_creation?.ephemeral_1h_input_tokens ? HOUR : u.cache_creation_input_tokens ? FIVE_MINUTES : prev?.ttl ?? FIVE_MINUTES;
    prev = { model: normalizeModel(rec.message.model), at: Date.parse(rec.timestamp), ttl };
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
    // Кэш продлевается каждым запросом, поэтому его срок отсчитывается от последнего.
    turn.lastAt = rec.timestamp;
    // Первый запрос при возвращении: живой кэш стол читает, остывший пишет заново; модель без цены — null, а не ноль.
    const key = normalizeModel(rec.message.model);
    const known = PRICES[key];
    if (!known) unpriced[key] = (unpriced[key] || 0) + 1;
    const cost = (usage) => priceRecord({ ...usage, speed: u.speed, inference_geo: u.inference_geo }, rec.message.model).usd;
    turn.entryLive = known ? cost({ cache_read_input_tokens: turn.table }) : null;
    turn.entryCold = known ? cost({ cache_creation: { ephemeral_1h_input_tokens: turn.table } }) : null;
    const ask = asks.get(rec.requestId || rec.uuid);
    if (ask) Object.assign(ask, { turn, seq: thread.requests, gen: priced.output - priced.thinking,
      genUsd: priced.output ? (priced.usdOutput * (priced.output - priced.thinking)) / priced.output : 0,
      readRate: known ? cost({ cache_read_input_tokens: 1e6 }) / 1e6 : 0 });
  }
  thread.title = named || thread.title || lastPrompt;
  // Входы вызовов — оценка: клиент не сообщает, сколько токенов ушло на них. Генерация запроса без размышлений
  // делится с текстом ответа по доле символов; перечитывание — те же токены в каждом следующем запросе треда по ставке чтения кэша.
  for (const ask of asks.values()) {
    const chars = Object.values(ask.tools).reduce((s, n) => s + n, 0);
    if (!ask.turn || !chars) continue;
    const later = thread.requests - ask.seq;
    for (const [name, n] of Object.entries(ask.tools)) {
      const tokens = (ask.gen * n) / (chars + ask.text);
      const slot = ((ask.turn.toolInputs ||= {})[name] ||= { chars: 0, tokens: 0, usd: 0, rereadTokens: 0, rereadUsd: 0 });
      slot.chars += n;
      slot.tokens += tokens;
      slot.usd += (ask.genUsd * n) / (chars + ask.text);
      slot.rereadTokens += tokens * later;
      slot.rereadUsd += tokens * later * ask.readRate;
    }
  }
}

// Вход клиента — чем оплачивается работа. Клиент сам пишет его в ~/.claude.json; оттуда берутся только поля входа,
// ключей и токенов в этом файле нет. Профиль плана клиент запрашивает только при входе через claude.ai, роль
// в рабочем пространстве бывает только у Console.
function currentLogin() {
  let a;
  try { a = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')).oauthAccount; } catch { return null; }
  if (!a?.organizationUuid) return null;
  if (a.planDisplayName || a.billingType || a.profileFetchedAt) {
    // Места бывают только у командных планов, Team и Enterprise: без места план личный.
    const seat = a.seatTier ? a.seatTier[0].toUpperCase() + a.seatTier.slice(1) : '';
    const plan = a.planDisplayName || 'подписка';
    const line = [`биллинг: ${plan}`, seat && `место: ${seat}`, `оплата: ${seat ? 'квота места' : 'квота подписки'}`,
      `кредиты сверх лимита: ${a.hasExtraUsageEnabled ? 'включены' : 'выключены'}`,
      `организация: ${seat ? a.organizationName || '—' : 'личная'}`].filter(Boolean).join(' · ');
    return { org: a.organizationUuid, line, short: plan.replace(/^Claude\s+/i, '').split(' ')[0] };
  }
  if (!a.workspaceRole) return null;
  return { org: a.organizationUuid, line: `биллинг: Console · оплата: по токенам · организация: ${a.organizationName || '—'}`, short: 'токены' };
}

// История входов: новая запись, когда вход сменился. Ход получает вход своей организации, действовавший в его время,
// а ход старше истории — самый ранний вход той же организации.
function logins(now) {
  const file = path.join(cacheDir(), 'logins.json');
  let list = [];
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* первый тик */ }
  const current = currentLogin();
  const last = list[list.length - 1];
  if (current && (!last || last.org !== current.org || last.line !== current.line)) {
    list.push({ at: now, ...current });
    if (STORE) fs.writeFileSync(file, JSON.stringify(list));
  }
  return { list, current };
}

const latest = (marks, at) => (marks.filter((x) => x.at <= at).pop() || marks[0]) ?? null;

// Разбор журнала зависит от кода сборщика и от цен: сменилось что-то из них — прежний кэш не годится.
const PARSER = JSON.stringify([
  ['dashboard-data.mjs', 'usage-lib.mjs', 'attachments.mjs'].map((f) => fs.statSync(new URL(f, import.meta.url)).mtimeMs),
  PRICES,
]);

function build(currentDir) {
  const threads = [];
  // Модель, которой нет в таблице цен, считается по нулям — панель должна сказать об этом вслух.
  const unpriced = {};
  const current = path.basename(currentDir);
  // Журнал только дописывается, поэтому разобранный тред годен, пока у файла прежние размер и время записи:
  // разбор всех журналов шёл секунды на каждом событии, а меняются обычно один-два открытых треда.
  const cacheFile = path.join(cacheDir(), 'journals.json');
  let before = {};
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (cached.parser === PARSER) before = cached.files;
  } catch { /* первый тик */ }
  const parsed = {};
  for (const project of fs.readdirSync(PROJECTS)) {
    // Сверка ставок работает во временной папке и удаляет свой журнал за собой,
    // но тик сборщика может успеть между запросом и уборкой — тогда пробная сессия
    // осталась бы в архиве навсегда. Поэтому её проекты не считаются вовсе.
    if (project.includes('usage-calibrate-')) continue;
    const dir = path.join(PROJECTS, project);
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries.filter((n) => n.endsWith('.jsonl'))) {
      const file = path.join(dir, name);
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      let entry = before[file];
      if (!entry || entry.size !== stat.size || entry.mtimeMs !== stat.mtimeMs) {
        const thread = newThread(project, name.slice(0, -6));
        const models = {};
        try { readLog(file, thread, new Set(), models); } catch { continue; }
        entry = { size: stat.size, mtimeMs: stat.mtimeMs, thread, unpriced: models };
      }
      parsed[file] = entry;
    }
  }
  // Снимок разбора пишется до того, как ниже ходы получат вход, а треды потеряют список организаций.
  if (STORE) writeAtomic(cacheFile, JSON.stringify({ parser: PARSER, files: parsed }));
  for (const { thread, unpriced: models } of Object.values(parsed)) {
    for (const [model, n] of Object.entries(models)) unpriced[model] = (unpriced[model] || 0) + n;
    if (thread.requests) threads.push(thread);
  }
  threads.sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
  const { list, current: login } = logins(new Date().toISOString());
  for (const t of threads) {
    for (const turn of t.turns) {
      const org = t.orgs && latest(t.orgs, turn.at);
      const hit = org && latest(list.filter((x) => x.org === org.org), turn.at);
      if (hit) turn.account = { line: hit.line, short: hit.short };
    }
    delete t.orgs;
  }
  // A project is named by its own root, not by whichever folder a session wandered
  // into: the client builds the journal directory name from the root path, so the
  // cwd that names it is the root. Threads of one project share it.
  const roots = new Map();
  for (const t of threads) {
    if (!t.dir || roots.get(t.project)) continue;
    if (namesJournalDir(t.project, t.dir)) roots.set(t.project, t.dir);
  }
  const label = (project, dir) => {
    const root = roots.get(project) || dir;
    return root ? path.basename(root) : project;
  };
  return {
    generatedAt: new Date().toISOString(),
    current,
    currentLabel: label(current, (threads.find((t) => t.project === current) || {}).dir),
    unpriced,
    account: login ? { line: login.line, short: login.short } : null,
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
// Первый тред нового проекта: хук приходит раньше, чем клиент заводит папку журналов, — собирать пока нечего.
if (dir && !fs.existsSync(dir) && !process.argv.includes('--dir')) process.exit(0);
if (!dir || !fs.existsSync(dir)) {
  process.stdout.write(`не указана папка проекта: передай --dir <папка в ${PROJECTS}> или подай JSON хука на stdin\n`);
  process.exit(1);
}
const dir2 = cacheDir();
const out = path.join(dir2, 'dashboard.json');
const data = build(dir);
// The hook's cwd follows the shell into subfolders, so it names the project only
// when the journals gave no root of their own.
if (currentCwd && !data.currentLabel) data.currentLabel = path.basename(currentCwd);
writeAtomic(out, JSON.stringify(data));
const stats = STORE ? updateArchive(data) : null;
if (process.argv.includes('--print')) {
  const usd = data.threads.reduce((a, t) => a + t.usd, 0);
  console.log(`проект ${data.currentLabel} · тредов ${data.threads.length} · ходов ${data.threads.reduce((a, t) => a + t.turns.length, 0)} · $${usd.toFixed(2)}`);
  for (const [model, n] of Object.entries(data.unpriced)) console.log(`нет цены: ${model} — запросов ${n}`);
  if (stats) {
    console.log(`архив: месяцев ${stats.months} (переписано ${stats.written}) · тредов ${stats.threads} · ходов ${stats.turns} · ${(stats.bytes / 1024).toFixed(0)} КБ`);
  }
  for (const t of data.threads.slice(0, 3)) {
    console.log(`  ${t.projectLabel} · ${t.title || t.id.slice(0, 8)} · $${t.usd.toFixed(2)} · запросов ${t.requests}`);
    for (const turn of t.turns.slice(0, 2)) console.log(`      ${turn.at.slice(5, 16)} $${turn.usd.toFixed(2)} «${turn.text}»`);
  }
}
