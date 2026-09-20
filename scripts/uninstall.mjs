#!/usr/bin/env node
// Убирает то, чего не уносит `/plugin uninstall`: расширение VS Code и, по явной
// просьбе, накопленные данные. Сам плагин, его хуки и скилл уходят командой клиента.
//
//   node uninstall.mjs             убрать расширение, данные оставить
//   node uninstall.mjs --data      убрать и данные (архив расхода — навсегда)
//   node uninstall.mjs --dry-run   показать, что будет удалено, ничего не трогая

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DRY = process.argv.includes('--dry-run');
const WITH_DATA = process.argv.includes('--data');

const extRoot = path.join(os.homedir(), '.vscode', 'extensions');
const dataDir = process.env.CLAUDE_USAGE_DIR || path.join(os.homedir(), '.claude', 'usage-counter');

// Версия входит в имя папки, поэтому после обновлений их может лежать несколько.
const extDirs = fs.existsSync(extRoot)
  ? fs.readdirSync(extRoot).filter((n) => n.startsWith('local.claude-usage-panel-'))
  : [];

// Что именно человек потеряет вместе с данными — считаем до удаления, а не после.
function describeData() {
  const archive = path.join(dataDir, 'archive');
  if (!fs.existsSync(archive)) return { months: 0, threads: 0, usd: 0 };
  let months = 0, threads = 0, usd = 0;
  for (const file of fs.readdirSync(archive).filter((f) => /^\d{4}-\d{2}\.json$/.test(f))) {
    months += 1;
    const data = JSON.parse(fs.readFileSync(path.join(archive, file), 'utf8'));
    threads += data.threads.length;
    usd += data.threads.reduce((sum, t) => sum + (t.usd || 0), 0);
  }
  return { months, threads, usd };
}

if (!extDirs.length) console.log('— расширения VS Code нет, удалять нечего');
for (const name of extDirs) console.log(`− расширение VS Code → ${path.join(extRoot, name)}`);

if (WITH_DATA) {
  if (fs.existsSync(dataDir)) {
    const { months, threads, usd } = describeData();
    console.log(`− данные → ${dataDir}`);
    console.log(`  в архиве месяцев ${months}, тредов ${threads}, на сумму $${usd.toFixed(2)} — восстановить будет нечем:`);
    console.log('  расход за периоды, которые Claude Code уже подчистил, есть только здесь');
  } else {
    console.log('— папки данных нет, удалять нечего');
  }
} else if (fs.existsSync(dataDir)) {
  console.log(`= данные остаются в ${dataDir} (удалить вместе с ними: --data)`);
}

if (DRY) {
  console.log('\n--dry-run: ничего не удалено.');
  process.exit(0);
}

for (const name of extDirs) fs.rmSync(path.join(extRoot, name), { recursive: true, force: true });
if (WITH_DATA) fs.rmSync(dataDir, { recursive: true, force: true });

console.log('\nготово. осталось убрать сам плагин командами клиента:');
console.log('  /plugin uninstall usage-panel@<витрина>');
console.log('  /plugin marketplace remove <витрина>');
if (extDirs.length) console.log('и выполнить «Developer: Reload Window» в VS Code.');
