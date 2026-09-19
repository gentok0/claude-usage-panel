// Permanent store for everything the panel shows. Session journals are deleted
// after cleanupPeriodDays (30 by default) and nothing can bring them back, so each
// pass folds the current window into files nobody cleans.
//
// One file per calendar month: only the months a tick actually touched get
// rewritten, past months are never opened again. The panel reads them merged.

import fs from 'node:fs';
import path from 'node:path';
import { cacheDir } from './usage-lib.mjs';

// Everything the table draws for a thread; the turns carry the rest.
const META = ['project', 'projectLabel', 'title', 'dir', 'firstAt', 'lastAt',
  'requests', 'usd', 'table', 'contextSize', 'compactAt', 'model', 'effort', 'missTokens'];

const MONTH_FILE = /^\d{4}-\d{2}\.json$/;
const byTime = (a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0);

export function archiveDir() {
  const dir = path.join(cacheDir(), 'archive');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function meta(thread) {
  const out = { id: thread.id };
  for (const k of META) if (thread[k] !== undefined) out[k] = thread[k];
  return out;
}

// Fold thread entries coming from several month files into one list: a thread that
// ran across a month boundary is stored in both, and its turns merge by time.
export function mergeThreads(list) {
  const byId = new Map();
  for (const t of list) {
    const prev = byId.get(t.id);
    if (!prev) { byId.set(t.id, { ...t, turns: [...t.turns] }); continue; }
    const turns = new Map(prev.turns.map((x) => [x.at, x]));
    for (const x of t.turns) turns.set(x.at, x);
    const newer = (t.lastAt || '') >= (prev.lastAt || '') ? t : prev;
    byId.set(t.id, { ...prev, ...newer, turns: [...turns.values()].sort(byTime) });
  }
  return [...byId.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
}

export function readArchive(dir = archiveDir()) {
  const all = [];
  for (const name of fs.readdirSync(dir).filter((n) => MONTH_FILE.test(n))) {
    try {
      all.push(...JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).threads);
    } catch { /* a half-written file must not cost the whole archive */ }
  }
  return mergeThreads(all);
}

// Merges the current window into the archive. Turns are keyed by thread and time:
// what the journals still hold wins, because a turn that is still running would
// otherwise freeze at whatever it was on its first tick; everything the journals
// have already lost is kept untouched.
export function updateArchive(data, dir = archiveDir()) {
  const months = new Map();
  for (const thread of data.threads) {
    for (const turn of thread.turns) {
      const month = String(turn.at || '').slice(0, 7);
      if (month.length !== 7) continue;
      if (!months.has(month)) months.set(month, new Map());
      const bucket = months.get(month);
      if (!bucket.has(thread.id)) bucket.set(thread.id, { ...meta(thread), turns: [] });
      bucket.get(thread.id).turns.push(turn);
    }
  }

  const stats = { months: 0, written: 0, threads: 0, turns: 0, bytes: 0 };
  for (const [month, bucket] of months) {
    const file = path.join(dir, `${month}.json`);
    let before = '';
    let stored = [];
    try {
      before = fs.readFileSync(file, 'utf8');
      stored = JSON.parse(before).threads || [];
    } catch { /* first month */ }

    const byId = new Map(stored.map((t) => [t.id, t]));
    for (const [id, live] of bucket) {
      const old = byId.get(id);
      if (!old) { byId.set(id, { ...live, turns: live.turns.slice().sort(byTime) }); continue; }
      const turns = new Map(old.turns.map((x) => [x.at, x]));
      for (const x of live.turns) turns.set(x.at, x);
      byId.set(id, { ...old, ...live, turns: [...turns.values()].sort(byTime) });
    }

    const threads = [...byId.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
    const text = JSON.stringify({ month, threads });
    stats.months += 1;
    stats.threads += threads.length;
    stats.turns += threads.reduce((a, t) => a + t.turns.length, 0);
    stats.bytes += Buffer.byteLength(text);
    if (text !== before) {
      fs.writeFileSync(file, text);
      stats.written += 1;
    }
  }
  return stats;
}
