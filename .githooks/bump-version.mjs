#!/usr/bin/env node
// Поднимает patch-версию плагина при коммите: клиент решает, обновлять ли плагин,
// по номеру версии в манифесте, а не по содержимому — без роста версии правки
// не доедут ни до своей машины, ни до чужой, причём молча.
//
//   node .githooks/bump-version.mjs             поднять и добавить в коммит
//   node .githooks/bump-version.mjs --dry-run   показать, ничего не трогая

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DRY = process.argv.includes('--dry-run');
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

// Версия живёт в манифесте плагина, а у панели ещё и в манифесте расширения VS Code:
// имя папки расширения берётся из первого, а VS Code читает второй — они обязаны совпадать.
const manifests = ['.claude-plugin/plugin.json', 'vscode-extension/package.json']
  .map((rel) => path.join(root, rel))
  .filter((file) => fs.existsSync(file));

const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

const meaningful = staged.filter((f) => !/(\.claude-plugin\/plugin\.json|vscode-extension\/package\.json)$/.test(f));
if (!meaningful.length) process.exit(0); // нечего выпускать — или коммитятся сами манифесты

const bumped = [];
for (const file of manifests) {
  const text = fs.readFileSync(file, 'utf8');
  const data = JSON.parse(text);
  const parts = String(data.version || '0.0.0').split('.');
  parts[2] = String(Number(parts[2] || 0) + 1);
  const next = parts.join('.');
  bumped.push(`${path.relative(root, file)}: ${data.version} → ${next}`);
  if (DRY) continue;
  // Правим точечно, чтобы не переформатировать чужой JSON целиком.
  fs.writeFileSync(file, text.replace(/("version"\s*:\s*")[^"]+"/, `$1${next}"`));
  execFileSync('git', ['add', file], { cwd: root });
}

console.log(`версия плагина поднята — ${bumped.join(', ')}${DRY ? ' (--dry-run, не записано)' : ''}`);
