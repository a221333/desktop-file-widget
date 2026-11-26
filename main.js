// 桌面文件小组件 —— 主进程
// 负责：窗口 / 托盘 / 配置持久化 / 读取“最近打开的文件” / 文件操作
const { app, BrowserWindow, ipcMain, shell, Menu, Tray, dialog, nativeImage, clipboard, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const isWin = process.platform === 'win32';

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
const CONFIG_PATH = () => path.join(app.getPath('userData'), 'config.json');
const DEFAULT_CONFIG = {
  favorites: [],          // [{ path, name? }]
  pinned: [],             // 最近文件中“收藏置顶”的路径
  hidden: [],             // 从最近列表中移除的路径
  bounds: null,           // 窗口位置大小
  alwaysOnTop: false,
  opacity: 'medium',      // low | medium | high
  maxRecent: 40,
  includeFolders: false,  // 最近列表是否包含文件夹
};
let config = { ...DEFAULT_CONFIG };

function loadConfig() {
  try {
    config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8')) };
  } catch {
    config = { ...DEFAULT_CONFIG };
  }
}
let saveTimer = null;
function saveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(CONFIG_PATH()), { recursive: true });
      fs.writeFileSync(CONFIG_PATH(), JSON.stringify(config, null, 2), 'utf8');
    } catch (e) {
      console.error('保存配置失败', e);
    }
  }, 300);
}

const norm = (p) => (isWin ? path.normalize(p).toLowerCase() : path.normalize(p));
const samePath = (a, b) => norm(a) === norm(b);

// ---------------------------------------------------------------------------
// 打开方式名称（例如 “WPS”、“Word”）
// ---------------------------------------------------------------------------
const appNameCache = new Map();

function regQuery(key, valueName) {
  return new Promise((resolve) => {
    const args = ['query', key];
    if (valueName === '') args.push('/ve');
    else if (valueName) args.push('/v', valueName);
    execFile('reg', args, { windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      if (err) return resolve(null);
      const line = stdout.split(/\r?\n/).find((l) => /REG_(EXPAND_)?SZ/.test(l));
      if (!line) return resolve(null);
      resolve(line.replace(/^.*?REG_(EXPAND_)?SZ\s+/, '').trim() || null);
    });
  });
}

function progIdToName(progId) {
  if (!progId) return null;
  const p = progId.toLowerCase();
  if (/^k(wps|et|wpp)\.|wps|kingsoft/.test(p)) return 'WPS';
  if (p.startsWith('word.')) return 'Word';
  if (p.startsWith('excel.')) return 'Excel';
  if (p.startsWith('powerpoint.')) return 'PowerPoint';
  if (p.includes('acro')) return 'Acrobat';
  if (p.includes('msedge')) return 'Edge';
  if (p.includes('chrome')) return 'Chrome';
  if (p.includes('firefox')) return 'Firefox';
  if (p.includes('foxit')) return 'Foxit';
  if (p.includes('vscode')) return 'VS Code';
  if (p.includes('photos')) return '照片';
  const m = progId.match(/Applications\\(.+?)\.exe/i);
  if (m) return m[1];
  return null;
}

const TYPE_LABELS = {
  doc: '文档', docx: '文档', wps: '文档', rtf: '文档', txt: '文本', md: '文本',
  xls: '表格', xlsx: '表格', et: '表格', csv: '表格',
  ppt: '演示', pptx: '演示', dps: '演示',
  pdf: 'PDF', ofd: 'OFD',
  jpg: '图片', jpeg: '图片', png: '图片', gif: '图片', bmp: '图片', webp: '图片',
  mp4: '视频', mkv: '视频', avi: '视频', mov: '视频',
  mp3: '音频', wav: '音频', flac: '音频',
  zip: '压缩包', rar: '压缩包', '7z': '压缩包',
};

async function appNameForExt(ext) {
  ext = (ext || '').toLowerCase();
  if (appNameCache.has(ext)) return appNameCache.get(ext);
  let name = null;
  if (isWin && ext) {
    const progId =
      (await regQuery(`HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.${ext}\\UserChoice`, 'ProgId')) ||
      (await regQuery(`HKCR\\.${ext}`, ''));
    name = progIdToName(progId);
  }
  name = name || TYPE_LABELS[ext] || (ext ? ext.toUpperCase() : '文件');
  appNameCache.set(ext, name);
  return name;
}

// ---------------------------------------------------------------------------
// 最近打开的文件
// ---------------------------------------------------------------------------
function statSafe(p) {
  try { return fs.statSync(p); } catch { return null; }
}

// Windows：读取 %APPDATA%\Microsoft\Windows\Recent 下的 .lnk 快捷方式
function recentFromWindows() {
  const dir = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Recent');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const items = [];
  for (const n of names) {
    if (!n.toLowerCase().endsWith('.lnk')) continue;
    const lnk = path.join(dir, n);
    const lst = statSafe(lnk);
    if (!lst) continue;
    let target;
    try { target = shell.readShortcutLink(lnk).target; } catch { continue; }
    if (!target) continue;
    items.push({ path: target, time: lst.mtimeMs });
  }
  return items;
}

// Linux（仅用于开发调试）：读取 recently-used.xbel
function recentFromXbel() {
  const file = path.join(os.homedir(), '.local', 'share', 'recently-used.xbel');
  let xml = '';
  try { xml = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const items = [];
  const re = /<bookmark[^>]*href="file:\/\/([^"]+)"[^>]*?(?:visited|modified)="([^"]+)"/g;
  let m;
  while ((m = re.exec(xml))) {
    items.push({ path: decodeURIComponent(m[1]), time: Date.parse(m[2]) || 0 });
  }
  return items;
}

// macOS / 无数据时的兜底：扫描常用目录中最近修改的文件
function recentFromScan() {
  const roots = ['desktop', 'documents', 'downloads'].map((k) => {
    try { return app.getPath(k); } catch { return null; }
  }).filter(Boolean);
  const items = [];
  for (const r of roots) {
    let names = [];
    try { names = fs.readdirSync(r); } catch { continue; }
    for (const n of names) {
      if (n.startsWith('.')) continue;
      const p = path.join(r, n);
      const st = statSafe(p);
      if (st && st.isFile()) items.push({ path: p, time: st.mtimeMs });
    }
  }
  return items;
}

async function getRecent() {
  let raw = isWin ? recentFromWindows() : recentFromXbel();
  if (!raw.length && !isWin) raw = recentFromScan();

  raw.sort((a, b) => b.time - a.time);
  const seen = new Set();
  const hidden = new Set(config.hidden.map(norm));
  const result = [];
  for (const it of raw) {
    const key = norm(it.path);
    if (seen.has(key) || hidden.has(key)) continue;
    const st = statSafe(it.path);
    if (!st) continue;                                // 已删除的文件不显示
    if (st.isDirectory() && !config.includeFolders) continue;
    seen.add(key);
    result.push({ path: it.path, time: it.time, isDir: st.isDirectory() });
    if (result.length >= config.maxRecent) break;
  }

  // 收藏置顶的条目排在最前（即使已不在系统最近列表中）
  const pinnedItems = [];
  for (const p of config.pinned) {
    const st = statSafe(p);
    if (!st) continue;
    const idx = result.findIndex((r) => samePath(r.path, p));
    const item = idx >= 0 ? result.splice(idx, 1)[0] : { path: p, time: st.mtimeMs, isDir: st.isDirectory() };
    pinnedItems.push({ ...item, pinned: true });
  }

  const all = [...pinnedItems, ...result];
  for (const it of all) {
    const ext = it.isDir ? '' : path.extname(it.path).slice(1);
    it.name = path.basename(it.path) || it.path;
    it.ext = ext.toLowerCase();
    it.app = it.isDir ? '文件夹' : await appNameForExt(ext);
  }
  return all;
}

function getFavorites() {
  return config.favorites.map((f) => {
    const st = statSafe(f.path);
    return {
      path: f.path,
      name: f.name || path.basename(f.path) || f.path,
      isDir: st ? st.isDirectory() : false,
      missing: !st,
      ext: st && !st.isDirectory() ? path.extname(f.path).slice(1).toLowerCase() : '',
    };
  });
}

function addFavorites(paths, index) {
  const fresh = paths.filter((p) => p && !config.favorites.some((f) => samePath(f.path, p)));
  if (!fresh.length) return;
  const entries = fresh.map((p) => ({ path: p }));
  if (typeof index === 'number' && index >= 0 && index <= config.favorites.length) {
    config.favorites.splice(index, 0, ...entries);
  } else {
    config.favorites.push(...entries);
  }
  saveConfig();
  notify('favorites-changed');
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------
let win = null;
let tray = null;

function notify(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function defaultBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 470, height = 660;
  return { width, height, x: workArea.x + workArea.width - width - 24, y: workArea.y + 24 };
}

function boundsVisible(b) {
  return screen.getAllDisplays().some(({ workArea: w }) =>
    b.x < w.x + w.width - 40 && b.x + b.width > w.x + 40 && b.y >= w.y - 10 && b.y < w.y + w.height - 40);
}

function createWindow() {
  const b = config.bounds && boundsVisible(config.bounds) ? config.bounds : defaultBounds();
  win = new BrowserWindow({
    ...b,
    minWidth: 340,
    minHeight: 420,
    frame: false,
    transparent: true,
    resizable: true,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: config.alwaysOnTop,
    show: false,
    title: '桌面文件小组件',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.showInactive());

  const remember = () => {
    if (!win.isMinimized()) { config.bounds = win.getBounds(); saveConfig(); }
  };
  win.on('moved', remember);
  win.on('resized', remember);
  win.on('focus', () => notify('recent-changed'));
}

// 监听系统“最近”目录的变化，自动刷新
function watchRecent() {
  if (!isWin) return;
  const dir = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Recent');
  let t = null;
  try {
    fs.watch(dir, () => { clearTimeout(t); t = setTimeout(() => notify('recent-changed'), 800); });
  } catch { /* 忽略 */ }
}

function trayIcon() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
  return img.isEmpty() ? img : img.resize({ width: 16, height: 16 });
}

function buildTrayMenu() {
  const opacityItem = (key, label) => ({
    label, type: 'radio', checked: config.opacity === key,
    click: () => { config.opacity = key; saveConfig(); notify('settings-changed', publicSettings()); },
  });
  return Menu.buildFromTemplate([
    { label: '显示 / 隐藏', click: toggleWindow },
    { type: 'separator' },
    {
      label: '始终置顶', type: 'checkbox', checked: config.alwaysOnTop,
      click: (mi) => { config.alwaysOnTop = mi.checked; win.setAlwaysOnTop(mi.checked); saveConfig(); },
    },
    {
      label: '开机自启', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      enabled: app.isPackaged, click: (mi) => app.setLoginItemSettings({ openAtLogin: mi.checked }),
    },
    {
      label: '最近列表包含文件夹', type: 'checkbox', checked: config.includeFolders,
      click: (mi) => { config.includeFolders = mi.checked; saveConfig(); notify('recent-changed'); },
    },
    { label: '背景不透明度', submenu: [opacityItem('low', '低（更通透）'), opacityItem('medium', '中'), opacityItem('high', '高（更清晰）')] },
    {
      label: '恢复已移除的最近文件', enabled: config.hidden.length > 0,
      click: () => { config.hidden = []; saveConfig(); notify('recent-changed'); refreshTray(); },
    },
    { label: '重置窗口位置', click: () => { win.setBounds(defaultBounds()); win.show(); } },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
}
function refreshTray() { if (tray) tray.setContextMenu(buildTrayMenu()); }

function toggleWindow() {
  if (win.isVisible()) win.hide();
  else { win.show(); win.focus(); }
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('桌面文件小组件');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', toggleWindow);
}

const publicSettings = () => ({ opacity: config.opacity, platform: process.platform });

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
const iconCache = new Map();
const PER_FILE_ICON_EXT = new Set(['exe', 'lnk', 'ico', 'url', 'appref-ms']);

function registerIpc() {
  ipcMain.handle('get-settings', () => publicSettings());
  ipcMain.handle('get-recent', () => getRecent());
  ipcMain.handle('get-favorites', () => getFavorites());

  ipcMain.handle('get-icon', async (_e, p, isDir) => {
    const ext = path.extname(p).slice(1).toLowerCase();
    const key = isDir ? 'dir:' + norm(p) : PER_FILE_ICON_EXT.has(ext) || !ext ? 'file:' + norm(p) : 'ext:' + ext;
    if (iconCache.has(key)) return iconCache.get(key);
    try {
      const img = await app.getFileIcon(p, { size: 'normal' });
      const url = img.isEmpty() ? null : img.toDataURL();
      iconCache.set(key, url);
      return url;
    } catch {
      iconCache.set(key, null);
      return null;
    }
  });

  ipcMain.handle('open', async (_e, p) => {
    const err = await shell.openPath(p);
    if (err) dialog.showMessageBox(win, { type: 'warning', message: '无法打开', detail: `${p}\n${err}` });
  });
  ipcMain.handle('reveal', (_e, p) => shell.showItemInFolder(p));

  ipcMain.handle('add-favorites', (_e, paths, index) => addFavorites(paths, index));
  ipcMain.handle('reorder-favorites', (_e, from, to) => {
    const list = config.favorites;
    if (from < 0 || from >= list.length) return;
    const [item] = list.splice(from, 1);
    list.splice(Math.max(0, Math.min(to, list.length)), 0, item);
    saveConfig();
    notify('favorites-changed');
  });

  ipcMain.handle('pick-favorites', async () => {
    const m = Menu.buildFromTemplate([
      { label: '添加文件…', click: () => pick(['openFile', 'multiSelections']) },
      { label: '添加文件夹…', click: () => pick(['openDirectory', 'multiSelections']) },
    ]);
    m.popup({ window: win });
    async function pick(properties) {
      const r = await dialog.showOpenDialog(win, { title: '添加到常用', properties });
      if (!r.canceled) addFavorites(r.filePaths);
    }
  });

  // 最近文件右键菜单
  ipcMain.handle('recent-menu', (_e, item) => {
    const pinned = config.pinned.some((p) => samePath(p, item.path));
    const isFav = config.favorites.some((f) => samePath(f.path, item.path));
    Menu.buildFromTemplate([
      { label: '打开', click: () => shell.openPath(item.path) },
      { label: '定位文件', click: () => shell.showItemInFolder(item.path) },
      { type: 'separator' },
      pinned
        ? { label: '取消收藏', click: () => { config.pinned = config.pinned.filter((p) => !samePath(p, item.path)); saveConfig(); notify('recent-changed'); } }
        : { label: '收藏置顶', click: () => { config.pinned.unshift(item.path); saveConfig(); notify('recent-changed'); } },
      { label: isFav ? '已在常用中' : '添加到常用', enabled: !isFav, click: () => addFavorites([item.path]) },
      { label: '复制路径', click: () => clipboard.writeText(item.path) },
      { type: 'separator' },
      {
        label: '从列表中移除', click: () => {
          config.hidden.push(item.path);
          config.pinned = config.pinned.filter((p) => !samePath(p, item.path));
          saveConfig(); notify('recent-changed'); refreshTray();
        },
      },
    ]).popup({ window: win });
  });

  // 常用文件右键菜单
  ipcMain.handle('favorite-menu', (_e, index) => {
    const fav = config.favorites[index];
    if (!fav) return;
    Menu.buildFromTemplate([
      { label: '打开', click: () => shell.openPath(fav.path) },
      { label: '定位文件', click: () => shell.showItemInFolder(fav.path) },
      { label: '重命名显示名称', click: () => notify('rename-favorite', index) },
      { label: '复制路径', click: () => clipboard.writeText(fav.path) },
      { type: 'separator' },
      { label: '移除收藏', click: () => { config.favorites.splice(index, 1); saveConfig(); notify('favorites-changed'); } },
    ]).popup({ window: win });
  });

  ipcMain.handle('rename-favorite', (_e, index, name) => {
    const fav = config.favorites[index];
    if (!fav) return;
    const n = (name || '').trim();
    if (n && n !== path.basename(fav.path)) fav.name = n; else delete fav.name;
    saveConfig();
    notify('favorites-changed');
  });

  ipcMain.handle('app-menu', () => buildTrayMenu().popup({ window: win }));
  ipcMain.handle('hide', () => win.hide());
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
  app.whenReady().then(() => {
    if (isWin) app.setAppUserModelId('com.desktop.file-widget');
    loadConfig();
    registerIpc();
    createWindow();
    createTray();
    watchRecent();
    setInterval(() => notify('recent-changed'), 60 * 1000);
  });
  app.on('window-all-closed', (e) => e.preventDefault()); // 关闭窗口后常驻托盘
}
