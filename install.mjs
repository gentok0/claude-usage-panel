#!/usr/bin/env node
// Разворачивает расширение VS Code — единственное, чего не доставить плагином.
// Настроек клиента установщик не трогает: человек ставит счётчик расхода, а не
// меняет себе конфигурацию.
//
//   node install.mjs             применить
//   node install.mjs --dry-run   показать, что будет сделано, ничего не трогая
//   node install.mjs --auto      тихо и только если нужно — этим режимом плагин
//                                разворачивает расширение сам, на старте сессии

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes('--dry-run');
const AUTO = process.argv.includes('--auto');
const say = (line) => { if (!AUTO) console.log(line); };

const EXT_SRC = path.join(HERE, 'vscode-extension');
const version = JSON.parse(fs.readFileSync(path.join(HERE, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const EXT_DST = path.join(os.homedir(), '.vscode', 'extensions', `local.claude-usage-panel-${version}`);
const EXT_ROOT = path.dirname(EXT_DST);

// Версия входит в имя папки, поэтому после обновления рядом остались бы копии прежних
// версий — VS Code загрузил бы их все.
const stale = fs.existsSync(EXT_ROOT)
  ? fs.readdirSync(EXT_ROOT).filter((n) => n.startsWith('local.claude-usage-panel-') && n !== path.basename(EXT_DST))
  : [];

// На машине без VS Code разворачивать нечего: каталога расширений нет, и создавать его
// самим — значит оставить след там, где человек нас не звал. Явный запуск это переживёт
// (сам попросил — сделаем), автоматический просто молчит.
if (AUTO && !fs.existsSync(EXT_ROOT)) process.exit(0);

const files = fs.readdirSync(EXT_SRC);
const upToDate = !stale.length && files.every((name) => {
  const src = path.join(EXT_SRC, name);
  const dst = path.join(EXT_DST, name);
  return fs.existsSync(dst) && fs.readFileSync(src).equals(fs.readFileSync(dst));
});

// В автоматическом режиме нечего сказать и нечего делать: выходим молча, не трогая диск.
if (AUTO && upToDate) process.exit(0);

const present = fs.existsSync(EXT_DST);
say(`${present ? '≈' : '+'} расширение VS Code → ${EXT_DST}${present ? ' (перезапись)' : ''}`);
for (const name of stale) say(`− прежняя версия → ${path.join(EXT_ROOT, name)}`);
if (!AUTO && upToDate) say('  (файлы уже совпадают)');

if (DRY) {
  console.log('\n--dry-run: ничего не записано.');
  process.exit(0);
}

for (const name of stale) fs.rmSync(path.join(EXT_ROOT, name), { recursive: true, force: true });
fs.mkdirSync(EXT_DST, { recursive: true });
for (const name of files) fs.copyFileSync(path.join(EXT_SRC, name), path.join(EXT_DST, name));

say('\nготово. в VS Code выполните «Developer: Reload Window», чтобы панель подхватилась.');
