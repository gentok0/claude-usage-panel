#!/usr/bin/env node
// Разворачивает расширение VS Code — единственное, чего не доставить плагином.
// Настроек клиента установщик не трогает: человек ставит счётчик расхода, а не
// меняет себе конфигурацию.
//
//   node install.mjs --dry-run   показать, что будет сделано, ничего не трогая
//   node install.mjs             применить

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes('--dry-run');
const EXT_SRC = path.join(HERE, 'vscode-extension');
const version = JSON.parse(fs.readFileSync(path.join(HERE, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const EXT_DST = path.join(os.homedir(), '.vscode', 'extensions', `local.claude-usage-panel-${version}`);

const present = fs.existsSync(EXT_DST);
console.log(`${present ? '≈' : '+'} расширение VS Code → ${EXT_DST}${present ? ' (перезапись)' : ''}`);

if (DRY) {
  console.log('\n--dry-run: ничего не записано.');
  process.exit(0);
}

fs.mkdirSync(EXT_DST, { recursive: true });
for (const name of fs.readdirSync(EXT_SRC)) fs.copyFileSync(path.join(EXT_SRC, name), path.join(EXT_DST, name));

console.log('\nготово. в VS Code выполните «Developer: Reload Window», чтобы панель подхватилась.');
