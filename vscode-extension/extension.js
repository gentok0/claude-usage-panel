const fs = require('fs');
const path = require('path');
const os = require('os');
const vscode = require('vscode');

const HOME = path.join(os.homedir(), '.claude', 'usage-counter');
const DATA = path.join(HOME, 'dashboard.json');
const ARCHIVE = path.join(HOME, 'archive');
const MONTH_FILE = /^\d{4}-\d{2}\.json$/;

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
  // Тем же способом, каким сборщик кодирует путь в имя папки журналов; регистр
  // у той папки свой, поэтому сравнение идёт в нижнем.
  const code = dir.replace(/[\\/:]/g, '-').toLowerCase();
  const own = (data.threads || []).find((t) => t.project.toLowerCase() === code);
  return { ...data, current: own ? own.project : code, currentLabel: path.basename(dir) };
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

class Dashboard {
  constructor(context) {
    this.context = context;
    this.view = null;
    this.wantArchive = false;
    this.monthSet = '';
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = fs.readFileSync(path.join(this.context.extensionPath, 'panel.html'), 'utf8');
    view.webview.onDidReceiveMessage((m) => {
      if (m === 'ready') this.push();
      // Asked for only when the period is "all time": the archive is the whole
      // history and weighs megabytes, while a tick needs the window alone.
      if (m === 'archive') { this.wantArchive = true; this.pushArchive(); }
    });

    // The counter rewrites the file on every tick; fs.watch misses some writes on
    // Windows, so a slow poll of the mtime backs it up.
    let seen = 0;
    const timer = setInterval(() => {
      let m = 0;
      try { m = fs.statSync(DATA).mtimeMs; } catch { /* not yet */ }
      if (m !== seen) { seen = m; this.push(); }
      // The current month changes on every tick, but those turns are in the window
      // anyway — only a new month file adds anything the panel does not have.
      if (this.wantArchive) {
        const set = months().join('|');
        if (set !== this.monthSet) this.pushArchive();
      }
    }, 1000);
    view.onDidDispose(() => clearInterval(timer));
  }

  push() {
    if (this.view) this.view.webview.postMessage({ kind: 'live', data: read() });
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
