// Вложения из сообщений человека: картинки, PDF и приложенные файлы. Журнал держит
// их внутри себя и удаляется вместе с ними, поэтому архив хранит копию, которую
// никто не чистит. Имя файла выводится из треда, времени сообщения и номера
// вложения — следующий тик находит его на месте и второй раз не пишет.

import fs from 'node:fs';
import path from 'node:path';
import { cacheRoot } from './usage-lib.mjs';

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf' };

export const filesDir = () => path.join(cacheRoot(), 'archive', 'files');

// Только блоки верхнего уровня: картинка внутри результата инструмента — это моё
// чтение файла, а не то, что приложил человек.
export function attachmentsOf(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((b) => {
    const s = b.source || {};
    if (b.type === 'image') return s.type === 'base64' && !!EXT[s.media_type];
    if (b.type === 'document') return s.type === 'text' || (s.type === 'base64' && s.media_type === 'application/pdf');
    return false;
  });
}

export function attachmentPath(threadId, at, n, block) {
  const stamp = String(at).replace(/[:.]/g, '-');
  const name = block.source.type === 'text'
    ? `-${String(block.title || 'text.txt').replace(/[\\/:*?"<>|]/g, '_')}`
    : `.${EXT[block.source.media_type]}`;
  return path.join(filesDir(), threadId, `${stamp}-${n}${name}`);
}

// Текст приложенного файла клиент кладёт в журнал, прочитав его байты как latin-1, и
// кириллица приезжает кракозябрами. Если строка вся из однобайтовых символов и её
// байты складываются в корректный UTF-8, пишем исходные байты.
function textBytes(data) {
  if (/[^\x00-\xff]/.test(data)) return Buffer.from(data, 'utf8');
  const raw = Buffer.from(data, 'latin1');
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(raw);
    return raw;
  } catch {
    return Buffer.from(data, 'utf8');
  }
}

export function mediaOf(block) {
  return block.source.type === 'text' ? 'text/plain' : block.source.media_type;
}

// write=false — для прогонов, которым нельзя трогать хранилище: путь есть, файла нет.
export function saveAttachments(threadId, at, blocks, write = true) {
  return blocks.map((b, i) => {
    const file = attachmentPath(threadId, at, i + 1, b);
    if (write && !fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, b.source.type === 'text' ? textBytes(b.source.data || '') : Buffer.from(b.source.data, 'base64'));
    }
    return { path: file, media: mediaOf(b) };
  });
}
