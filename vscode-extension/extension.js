const fs = require('fs');
const path = require('path');
const os = require('os');
const vscode = require('vscode');

const HOME = process.env.CLAUDE_USAGE_DIR || path.join(os.homedir(), '.claude', 'usage-counter');
const DATA = path.join(HOME, 'dashboard.json');
const ARCHIVE = path.join(HOME, 'archive');
const FILES = path.join(ARCHIVE, 'files');
const PAGE = path.join(HOME, 'panel.html');
const SESSIONS = path.join(os.homedir(), '.claude', 'sessions');
const mtimeOf = (file) => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } };
const MONTH_FILE = /^\d{4}-\d{2}\.json$/;

// Открывает только вложения архива: путь приходит со страницы, и всё за пределами
// папки вложений отклоняется. Показывает сам VS Code — сторонних программ панель не запускает.
function openAttachment(file) {
  const full = path.resolve(String(file || ''));
  const inside = path.relative(FILES, full);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside) || !fs.existsSync(full)) return;
  vscode.commands.executeCommand('vscode.open', vscode.Uri.file(full));
}

function read() {
  try {
    return scoped(JSON.parse(fs.readFileSync(DATA, 'utf8')));
  } catch {
    return { threads: [], generatedAt: null };
  }
}

// Сборщик пишет один файл на все проекты и называет текущим тот, из которого
// пришёл хук. Окно знает свою папку само — иначе в проекте, где Claude Code ещё
// не работал, панель показывает чужой расход под подписью «текущий проект».
function scoped(data) {
  const folder = (vscode.workspace?.workspaceFolders || [])[0];
  if (!folder) return data;
  const dir = folder.uri.fsPath;
  // Свой проект — тот, чьи треды начинались в этой папке: путь клиент пишет в журнал целиком, а имя папки
  // журналов собирает из него с потерями. «й» и «ё» бывают одним знаком и двумя, а на macOS клиент видит настоящий путь.
  const key = (p) => { const s = String(p).normalize('NFC'); return process.platform === 'linux' ? s : s.toLowerCase(); };
  const keys = new Set([key(dir)]);
  try { keys.add(key(fs.realpathSync(dir))); } catch { /* папки нет */ }
  const own = (data.threads || []).find((t) => t.dir && keys.has(key(t.dir)));
  return { ...data, current: own ? own.project : '', currentLabel: path.basename(dir) };
}

const months = () => {
  try { return fs.readdirSync(ARCHIVE).filter((n) => MONTH_FILE.test(n)).sort(); } catch { return []; }
};

// Threads of every month, as they lie: the panel folds them together and puts the
// live window on top, so the running turn always comes from the journals.
function readArchive() {
  const all = [];
  for (const name of months()) {
    try { all.push(...JSON.parse(fs.readFileSync(path.join(ARCHIVE, name), 'utf8')).threads); } catch { /* skip */ }
  }
  return all;
}

// Треды, где сейчас идёт ход. Клиент Claude держит по файлу на каждый свой процесс: номер процесса, тред и «занят».
// Файл убитого процесса остаётся на диске, поэтому процесс должен быть жив и запущен после включения машины.
function running() {
  let names;
  try { names = fs.readdirSync(SESSIONS).filter((n) => /^\d+\.json$/.test(n)); } catch { return []; }
  const boot = Date.now() - os.uptime() * 1000;
  const ids = new Set();
  for (const name of names) {
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(SESSIONS, name), 'utf8')); } catch { continue; }
    if (s.status === 'busy' && typeof s.sessionId === 'string' && s.startedAt > boot && alive(s.pid)) ids.add(s.sessionId);
  }
  return [...ids].sort();
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

class Dashboard {
  constructor(context) {
    this.context = context;
    this.view = null;
    this.busy = [];
    this.wantArchive = false;
    this.monthSet = '';
  }

  // Страницу кладёт в папку данных установщик плагина: новая страница приходит вместе с плагином,
  // без нового расширения. Своя копия — на случай, когда там её ещё нет.
  page() {
    try { return fs.readFileSync(PAGE, 'utf8'); } catch { return fs.readFileSync(path.join(this.context.extensionPath, 'panel.html'), 'utf8'); }
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.page();
    view.webview.onDidReceiveMessage((m) => {
      if (m === 'ready') { this.push(); this.pushBusy(); }
      // Asked for only when the period is "all time": the archive is the whole
      // history and weighs megabytes, while a tick needs the window alone.
      if (m === 'archive') { this.wantArchive = true; this.pushArchive(); }
      if (m && m.kind === 'open') openAttachment(m.path);
    });

    // The counter rewrites the file on every tick; fs.watch misses some writes on
    // Windows, so a slow poll of the mtime backs it up.
    let seen = 0;
    let pageAt = mtimeOf(PAGE);
    const timer = setInterval(() => {
      const m = mtimeOf(DATA);
      if (m !== seen) { seen = m; this.push(); }
      // Обновлённая страница подменяется сразу — перезагружать окно ради неё не нужно.
      const p = mtimeOf(PAGE);
      if (p !== pageAt) { pageAt = p; view.webview.html = this.page(); }
      // The current month changes on every tick, but those turns are in the window
      // anyway — only a new month file adds anything the panel does not have.
      if (this.wantArchive) {
        const set = months().join('|');
        if (set !== this.monthSet) this.pushArchive();
      }
      // Ход начинается и кончается без записи в файл данных, а погашенный ход хуков не зовёт вовсе.
      const busy = running();
      if (busy.join('|') !== this.busy.join('|')) { this.busy = busy; this.pushBusy(); }
    }, 1000);
    view.onDidDispose(() => clearInterval(timer));
  }

  push() {
    if (this.view) this.view.webview.postMessage({ kind: 'live', data: read() });
  }

  pushBusy() {
    if (this.view) this.view.webview.postMessage({ kind: 'busy', ids: this.busy });
  }

  pushArchive() {
    if (!this.view) return;
    this.monthSet = months().join('|');
    this.view.webview.postMessage({ kind: 'archive', threads: readArchive() });
  }
}

function activate(context) {
  const provider = new Dashboard(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('claudeUsage.dashboard', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
}

module.exports = { activate, deactivate() {} };
