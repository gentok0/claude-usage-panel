#!/usr/bin/env node
// Сверка наших ставок с ценой, которую считает сам Claude Code, и подбор множителя.
// Нужна на новой машине: списочные цены у всех одинаковые, а план может быть со скидкой.
//
// Как работает: один короткий запрос к вашему же клиенту с включённой телеметрией.
// Клиент печатает свою цену и свои токены, мы считаем цену по тем же токенам своей
// таблицей и сравниваем. Наружу ничего не уходит: метрики идут в консоль, не в сеть.
//
//   node calibrate.mjs                 сверить и показать расхождение
//   node calibrate.mjs --apply         записать подобранный множитель в prices.json
//   node calibrate.mjs --model <id>    сверять на другой модели (по умолчанию — ваша обычная)
//   node calibrate.mjs --keep          не удалять журнал пробного запроса
//   --claude <путь>                    свой путь к клиенту, если он не в PATH
//   --json                             машинный вывод

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { cacheDir, isRealRequest, normalizeModel, scanTranscript, fmtUsd } from './usage-lib.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : argv[i + 1];
};
const has = (name) => argv.includes(name);

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const encodeProject = (dir) => dir.replace(/[\\/:]/g, '-').toLowerCase();

// Модель по умолчанию — та, которой человек реально работает: считаем по свежим записям.
export function usualModel() {
  const counts = {};
  let newest = 0;
  for (const proj of fs.existsSync(PROJECTS) ? fs.readdirSync(PROJECTS) : []) {
    const dir = path.join(PROJECTS, proj);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
      const full = path.join(dir, file);
      const st = fs.statSync(full);
      if (st.mtimeMs < newest - 7 * 86400e3) continue;
      newest = Math.max(newest, st.mtimeMs);
      for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
        if (!line.includes('"model"')) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        if (!isRealRequest(rec)) continue;
        const id = rec.message.model;
        counts[id] = (counts[id] || 0) + 1;
      }
    }
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : null;
}

// Вывод телеметрии — это дамп объектов, не JSON: берём последний экспорт каждой метрики.
function lastMetricBlock(text, metric) {
  const start = text.lastIndexOf(`name: "${metric}"`);
  if (start === -1) return '';
  const next = text.indexOf('name: "claude_code.', start + metric.length + 8);
  return text.slice(start, next === -1 ? undefined : next);
}

export function parseTelemetry(text) {
  const costBlock = lastMetricBlock(text, 'claude_code.cost.usage');
  const tokenBlock = lastMetricBlock(text, 'claude_code.token.usage');
  const values = [...costBlock.matchAll(/value: ([\d.]+)/g)].map((m) => Number(m[1]));
  const tokens = {};
  for (const m of tokenBlock.matchAll(/type: "(\w+)",\s*\n\s*\},\s*\n[\s\S]{0,120}?value: (\d+)/g)) {
    tokens[m[1]] = (tokens[m[1]] || 0) + Number(m[2]);
  }
  const session = text.match(/"session\.id": "([\w-]+)"/);
  return {
    usd: values.length ? values[values.length - 1] : null,
    tokens,
    session: session ? session[1] : null,
  };
}

// Наш расчёт: берём журнал пробного запроса — только там запись кэша разделена
// на часовую и пятиминутную, а ставки у них разные.
function ourPrice(journal) {
  const byModel = {};
  scanTranscript(fs.readFileSync(journal, 'utf8'), new Set(), byModel, {});
  let usd = 0;
  const totals = { cacheRead: 0, cacheCreation: 0, input: 0, output: 0 };
  for (const t of Object.values(byModel)) {
    usd += t.usd || 0;
    totals.cacheRead += t.cacheRead;
    totals.cacheCreation += t.cacheWrite1h + t.cacheWrite5m;
    totals.input += t.input;
    totals.output += t.output;
  }
  return { usd, totals };
}

function dropFromArchive(sessionId) {
  const dir = path.join(cacheDir(), 'archive');
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  for (const file of fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.json$/.test(f))) {
    const full = path.join(dir, file);
    const data = JSON.parse(fs.readFileSync(full, 'utf8'));
    const kept = data.threads.filter((t) => t.id !== sessionId);
    if (kept.length === data.threads.length) continue;
    removed += data.threads.length - kept.length;
    fs.writeFileSync(full, JSON.stringify({ ...data, threads: kept }));
  }
  return removed;
}

function main() {
const model = arg('--model', usualModel() || 'claude-sonnet-5');
const bin = arg('--claude', 'claude');
const room = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-calibrate-'));

const run = spawnSync(bin, ['-p', 'ok', '--model', model], {
  cwd: room,
  shell: true,
  encoding: 'utf8',
  maxBuffer: 64e6,
  env: {
    ...process.env,
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: 'console',
    OTEL_LOGS_EXPORTER: 'none',
    OTEL_METRIC_EXPORT_INTERVAL: '1000',
  },
});

const out = `${run.stdout || ''}${run.stderr || ''}`;
const metric = parseTelemetry(out);

if (metric.usd === null) {
  console.error(`клиент не отдал метрику стоимости (код ${run.status}).`);
  console.error('возможные причины: клиент не найден по пути, старая версия, вход не выполнен.');
  console.error(out.slice(-600).trim() || '(пустой вывод)');
  process.exit(1);
}

const journal = path.join(PROJECTS, encodeProject(room), `${metric.session}.jsonl`);
if (!fs.existsSync(journal)) {
  console.error(`журнал пробного запроса не найден: ${journal}`);
  process.exit(1);
}

const ours = ourPrice(journal);
const ratio = ours.usd > 0 ? metric.usd / ours.usd : 0;
const driftPct = ours.usd > 0 ? (ratio - 1) * 100 : 0;
const tokensMatch =
  (metric.tokens.cacheRead ?? 0) === ours.totals.cacheRead &&
  (metric.tokens.cacheCreation ?? 0) === ours.totals.cacheCreation;

if (!has('--keep')) {
  fs.rmSync(path.join(PROJECTS, encodeProject(room)), { recursive: true, force: true });
  dropFromArchive(metric.session);
}
fs.rmSync(room, { recursive: true, force: true });

if (has('--json')) {
  console.log(JSON.stringify({ model, client: metric.usd, ours: ours.usd, ratio, tokensMatch }));
  process.exit(0);
}

console.log(`модель ${normalizeModel(model)} · пробный запрос стоил ${fmtUsd(metric.usd)}`);
console.log(`  клиент посчитал: ${metric.usd.toFixed(6)} $`);
console.log(`  мы посчитали:    ${ours.usd.toFixed(6)} $`);
if (!tokensMatch) {
  console.log('\n! токены клиента и журнала разошлись — сравнивать цены нельзя, сверка недостоверна');
  console.log(`  клиент: чтение ${metric.tokens.cacheRead ?? 0}, запись ${metric.tokens.cacheCreation ?? 0}`);
  console.log(`  журнал: чтение ${ours.totals.cacheRead}, запись ${ours.totals.cacheCreation}`);
  process.exit(2);
}

if (Math.abs(driftPct) < 0.5) {
  console.log('\nставки сходятся, правка не нужна.');
  process.exit(0);
}

console.log(`\nрасхождение ${driftPct > 0 ? '+' : ''}${driftPct.toFixed(1)} % — похоже на другие ставки плана.`);
console.log(`предлагаемый множитель: ${ratio.toFixed(4)} (применяется ко всем моделям сразу)`);

if (!has('--apply')) {
  console.log('записать: тот же вызов с --apply');
  process.exit(0);
}

const file = path.join(process.env.CLAUDE_PLUGIN_DATA || cacheDir(), 'prices.json');
const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
fs.writeFileSync(file, JSON.stringify({ ...current, multiplier: Number(ratio.toFixed(4)) }, null, 2));
console.log(`записано в ${file}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
