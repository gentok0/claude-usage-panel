#!/usr/bin/env node
// Разворачивает расширение VS Code — единственное, чего не доставить плагином, — и кладёт
// страницу панели в папку данных: расширение берёт её оттуда, поэтому новая страница приходит
// вместе с плагином, без перезагрузки окна. Настроек клиента установщик не трогает: человек
// ставит счётчик расхода, а не меняет себе конфигурацию.
//
//   node install.mjs             применить
//   node install.mjs --dry-run   показать, что будет сделано, ничего не трогая
//   node install.mjs --auto      тихо и только если нужно — этим режимом плагин
//                                разворачивает расширение сам, на старте сессии

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { cacheRoot } from './scripts/usage-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes('--dry-run');
const AUTO = process.argv.includes('--auto');
const say = (line) => { if (!AUTO) console.log(line); };

const EXT_SRC = path.join(HERE, 'vscode-extension');
const version = JSON.parse(fs.readFileSync(path.join(HERE, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const EXT_DST = path.join(os.homedir(), '.vscode', 'extensions', `local.claude-usage-panel-${version}`);
const EXT_ROOT = path.dirname(EXT_DST);
const PAGE_SRC = path.join(EXT_SRC, 'panel.html');
const PAGE_DST = path.join(cacheRoot(), 'panel.html');

// Версия входит в имя папки, поэтому после обновления рядом остались бы копии прежних
// версий — VS Code загрузил бы их все.
const stale = fs.existsSync(EXT_ROOT)
  ? fs.readdirSync(EXT_ROOT).filter((n) => n.startsWith('local.claude-usage-panel-') && n !== path.basename(EXT_DST))
  : [];

// На машине без VS Code разворачивать нечего: каталога расширений нет, и создавать его
// самим — значит оставить след там, где человек нас не звал. Явный запуск это переживёт
// (сам попросил — сделаем), автоматический просто молчит.
if (AUTO && !fs.existsSync(EXT_ROOT)) process.exit(0);

const same = (a, b) => fs.existsSync(a) && fs.existsSync(b) && fs.readFileSync(a).equals(fs.readFileSync(b));
const files = fs.readdirSync(EXT_SRC);
const upToDate = !stale.length && files.every((name) => same(path.join(EXT_SRC, name), path.join(EXT_DST, name)));
const pageFresh = same(PAGE_SRC, PAGE_DST);

// В автоматическом режиме нечего сказать и нечего делать: выходим молча, не трогая диск.
if (AUTO && upToDate && pageFresh) process.exit(0);

// Перезагрузка окна нужна, только если сменился код расширения или его объявление: страницу оно
// подменяет само. Номер версии в объявлении растёт с каждым коммитом панели и в счёт не идёт.
const manifestOf = (dir) => {
  try { const m = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); delete m.version; return JSON.stringify(m); } catch { return ''; }
};
const loaded = [EXT_DST, ...stale.map((n) => path.join(EXT_ROOT, n))].find((dir) => fs.existsSync(path.join(dir, 'extension.js')));
const reload = !upToDate && (!loaded || !same(path.join(EXT_SRC, 'extension.js'), path.join(loaded, 'extension.js'))
  || manifestOf(EXT_SRC) !== manifestOf(loaded));

const present = fs.existsSync(EXT_DST);
if (!upToDate) say(`${present ? '≈' : '+'} расширение VS Code → ${EXT_DST}${present ? ' (перезапись)' : ''}`);
for (const name of stale) say(`− прежняя версия → ${path.join(EXT_ROOT, name)}`);
if (!pageFresh) say(`${fs.existsSync(PAGE_DST) ? '≈' : '+'} страница панели → ${PAGE_DST}`);
if (!AUTO && upToDate && pageFresh) say('  (файлы уже совпадают)');

if (DRY) {
  console.log('\n--dry-run: ничего не записано.');
  process.exit(0);
}

if (!upToDate) {
  for (const name of stale) fs.rmSync(path.join(EXT_ROOT, name), { recursive: true, force: true });
  fs.mkdirSync(EXT_DST, { recursive: true });
  for (const name of files) fs.copyFileSync(path.join(EXT_SRC, name), path.join(EXT_DST, name));
}
if (!pageFresh) {
  fs.mkdirSync(path.dirname(PAGE_DST), { recursive: true });
  fs.copyFileSync(PAGE_SRC, PAGE_DST);
}

if (AUTO) {
  if (reload) console.log('Панель расхода: обновилось само расширение VS Code. В конце ответа напиши пользователю отдельной строкой: «Обновилась панель — сделай Developer: Reload Window».');
} else {
  say(reload ? '\nготово. в VS Code выполните «Developer: Reload Window», чтобы панель подхватилась.' : '\nготово. страница панели обновится сама, перезагружать окно не нужно.');
}
