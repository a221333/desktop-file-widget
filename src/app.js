/* 桌面文件小组件 —— 前端（Tauri） */
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const currentWebview = window.__TAURI__.webviewWindow.getCurrentWebviewWindow();

const $ = (s) => document.querySelector(s);
const recentList = $('#recent-list');
const favList = $('#fav-list');
const favCard = $('#fav-card');
let settings = { opacity: 'medium', ocBuild: false };

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
function fmtTime(ms) {
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 按显示宽度做“中间省略”：2026春营养...台账.xlsx
const charW = (c) => (/[\u2e80-\uffff]/.test(c) ? 2 : 1);
function middleEllipsis(name, maxW = 22) {
  const chars = Array.from(name);
  const width = chars.reduce((s, c) => s + charW(c), 0);
  if (width <= maxW) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : '';
  const base = Array.from(ext ? name.slice(0, dot) : name);
  const budget = maxW - ext.length - 3;
  const headW = Math.ceil(budget * 0.6), tailW = budget - headW;
  let head = '', w = 0;
  for (const c of base) { if (w + charW(c) > headW) break; head += c; w += charW(c); }
  let tail = ''; w = 0;
  for (let i = base.length - 1; i >= 0; i--) { if (w + charW(base[i]) > tailW) break; tail = base[i] + tail; w += charW(base[i]); }
  return `${head}...${tail}${ext}`;
}

// 系统图标获取失败时的彩色兜底图标
const FALLBACK = [
  [/^(xlsx?|et|csv)$/, '#1f9d55', 'S'],
  [/^(docx?|wps|rtf)$/, '#2f6fde', 'W'],
  [/^(pptx?|dps)$/, '#e8672c', 'P'],
  [/^pdf$/, '#e2364b', 'PDF'],
  [/^(png|jpe?g|gif|bmp|webp|svg)$/, '#8e5be8', '图'],
  [/^(zip|rar|7z)$/, '#c99a12', 'Z'],
  [/^(txt|md)$/, '#5b6b82', 'T'],
];
function fallbackIcon(item) {
  if (item.isDir) {
    return '<svg viewBox="0 0 24 24"><path fill="#f5b938" d="M2 6a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z"/><path fill="#fcd462" d="M2 9h20v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z"/></svg>';
  }
  const hit = FALLBACK.find(([re]) => re.test(item.ext || ''));
  const [color, label] = hit ? [hit[1], hit[2]] : ['#7c8aa0', (item.ext || '?').slice(0, 3).toUpperCase()];
  const fs = label.length > 2 ? 6.5 : label.length > 1 ? 8 : 11;
  return `<svg viewBox="0 0 24 24"><rect x="3" y="1.5" width="18" height="21" rx="3" fill="${color}"/>` +
    `<text x="12" y="15.5" text-anchor="middle" font-size="${fs}" font-weight="700" fill="#fff" font-family="Arial">${label}</text></svg>`;
}

async function setIcon(el, item) {
  el.innerHTML = fallbackIcon(item);
  if (item.missing) return;
  try {
    const url = await invoke('get_icon', { path: item.path, isDir: item.isDir });
    if (url) {
      const img = new Image();
      img.src = url;
      img.draggable = false;
      el.replaceChildren(img);
    }
  } catch { /* 使用兜底图标 */ }
}

function makeTile(item, title, sub) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.title = item.path;
  tile.innerHTML = '<div class="ico"></div><div class="meta"><div class="name"></div><div class="sub"></div></div>';
  tile.querySelector('.name').textContent = title;
  tile.querySelector('.sub').textContent = sub;
  setIcon(tile.querySelector('.ico'), item);
  return tile;
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  toast('已复制路径');
}

// ---------------------------------------------------------------------------
// 提示条
// ---------------------------------------------------------------------------
let toastTimer = null;
function toast(msg, buttons = [], ms = 2200) {
  const el = $('#toast');
  clearTimeout(toastTimer);
  el.replaceChildren();
  const text = document.createElement('div');
  text.textContent = msg;
  el.appendChild(text);
  if (buttons.length) {
    const row = document.createElement('div');
    row.className = 'row';
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.textContent = b.label;
      if (b.primary) btn.className = 'primary';
      btn.onclick = () => { el.classList.add('hidden'); b.action && b.action(); };
      row.appendChild(btn);
    }
    el.appendChild(row);
  } else {
    toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
  }
  el.classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// 打开 / 定位（含 OneCommander 处理）
// ---------------------------------------------------------------------------
async function pickOneCommander() {
  const p = await invoke('plugin:dialog|open', {
    options: { title: '选择 OneCommander.exe', multiple: false, directory: false, filters: [{ name: 'OneCommander', extensions: ['exe'] }] },
  });
  if (!p) return false;
  await invoke('set_setting', { key: 'ocPath', value: p });
  return true;
}

async function runPathAction(cmd, path, forceSystem = false) {
  try {
    await invoke(cmd, { path, forceSystem });
  } catch (err) {
    const msg = String(err);
    if (msg.includes('OC_NOT_FOUND')) {
      toast('没有找到 OneCommander，请指定 OneCommander.exe 的位置', [
        { label: '取消' },
        { label: '用资源管理器', action: () => runPathAction(cmd, path, true) },
        { label: '选择…', primary: true, action: async () => { if (await pickOneCommander()) runPathAction(cmd, path); } },
      ]);
    } else {
      toast(msg, [], 3500);
    }
  }
}
const openPath = (p, force) => runPathAction('open_path', p, force);
const revealPath = (p, force) => runPathAction('reveal', p, force);
const useOC = () => settings.ocBuild && settings.useOneCommander;

// ---------------------------------------------------------------------------
// 菜单（页面内实现）
// ---------------------------------------------------------------------------
const menuEl = $('#menu');
function showMenu(x, y, items) {
  menuEl.replaceChildren();
  for (const it of items) {
    if (it === '-') { menuEl.appendChild(Object.assign(document.createElement('div'), { className: 'sep' })); continue; }
    if (it.title) { menuEl.appendChild(Object.assign(document.createElement('div'), { className: 'title', textContent: it.title })); continue; }
    const mi = document.createElement('div');
    mi.className = 'mi' + (it.disabled ? ' disabled' : '');
    const ck = document.createElement('span');
    ck.className = 'ck';
    ck.textContent = it.checked ? '✓' : '';
    const label = document.createElement('span');
    label.textContent = it.label;
    mi.append(ck, label);
    if (it.sub) mi.appendChild(Object.assign(document.createElement('span'), { className: 'sub', textContent: it.sub }));
    mi.addEventListener('click', () => { hideMenu(); it.action && it.action(); });
    menuEl.appendChild(mi);
  }
  menuEl.classList.remove('hidden');
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 6)) + 'px';
  menuEl.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 6)) + 'px';
}
function hideMenu() { menuEl.classList.add('hidden'); }
document.addEventListener('pointerdown', (e) => { if (!menuEl.contains(e.target)) hideMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideMenu(); });
window.addEventListener('blur', hideMenu);
document.addEventListener('contextmenu', (e) => e.preventDefault()); // 屏蔽浏览器默认菜单

const setSetting = (key, value) => invoke('set_setting', { key, value }).catch((e) => toast(String(e)));

function showAppMenu(x, y) {
  const s = settings;
  const items = [
    { title: '背景不透明度' },
    { label: '低（更通透）', checked: s.opacity === 'low', action: () => setSetting('opacity', 'low') },
    { label: '中', checked: s.opacity === 'medium', action: () => setSetting('opacity', 'medium') },
    { label: '高（更清晰）', checked: s.opacity === 'high', action: () => setSetting('opacity', 'high') },
    '-',
    { label: '始终置顶', checked: s.alwaysOnTop, action: () => setSetting('alwaysOnTop', !s.alwaysOnTop) },
    { label: '开机自启', checked: s.autoStart, action: () => setSetting('autoStart', !s.autoStart) },
    { label: '最近列表包含文件夹', checked: s.includeFolders, action: () => setSetting('includeFolders', !s.includeFolders) },
  ];
  if (s.ocBuild) {
    items.push('-',
      { label: '用 OneCommander 打开文件夹', checked: s.useOneCommander, action: () => setSetting('useOneCommander', !s.useOneCommander) },
      { label: '记录从 OneCommander 打开的文件', checked: s.trackOneCommander, action: () => setSetting('trackOneCommander', !s.trackOneCommander) },
      { label: '设置 OneCommander 路径…', sub: s.ocPath ? s.ocPath.split(/[\\/]/).slice(-2).join('\\') : '自动检测', action: pickOneCommander });
  }
  items.push('-',
    { label: '恢复已移除的最近文件', disabled: !s.hiddenCount, sub: s.hiddenCount ? `${s.hiddenCount} 项` : '', action: () => invoke('restore_hidden') },
    { label: '重置窗口位置', action: () => invoke('reset_position') },
    { label: '检查更新', action: () => checkUpdate(true) },
    { label: '隐藏到托盘', action: () => invoke('hide_window') },
    { label: '退出', action: () => invoke('quit') },
    { title: `版本 ${s.version || ''}${s.ocBuild ? ' · OneCommander 版' : ''}` });
  showMenu(x, y, items);
}

function showRecentMenu(e, item) {
  showMenu(e.clientX, e.clientY, [
    { label: '打开', action: () => openPath(item.path) },
    { label: useOC() ? '在 OneCommander 中定位' : '定位文件', action: () => revealPath(item.path) },
    ...(useOC() ? [{ label: '在资源管理器中定位', action: () => revealPath(item.path, true) }] : []),
    '-',
    item.pinned
      ? { label: '取消收藏', action: () => invoke('set_pinned', { path: item.path, pinned: false }) }
      : { label: '收藏置顶', action: () => invoke('set_pinned', { path: item.path, pinned: true }) },
    { label: favorites.some((f) => samePath(f.path, item.path)) ? '已在常用中' : '添加到常用',
      disabled: favorites.some((f) => samePath(f.path, item.path)),
      action: () => invoke('add_favorites', { paths: [item.path], index: null }) },
    { label: '复制路径', action: () => copyText(item.path) },
    '-',
    { label: '从列表中移除', action: () => invoke('hide_recent', { path: item.path }) },
  ]);
}

function showFavoriteMenu(e, item, index) {
  const ocDir = useOC() && item.isDir;
  showMenu(e.clientX, e.clientY, [
    { label: ocDir ? '在 OneCommander 中打开' : '打开', disabled: item.missing, action: () => openPath(item.path) },
    ...(ocDir ? [{ label: '用资源管理器打开', disabled: item.missing, action: () => openPath(item.path, true) }] : []),
    { label: useOC() ? '在 OneCommander 中定位' : '定位文件', action: () => revealPath(item.path) },
    { label: '重命名显示名称', action: () => startRename(index) },
    { label: '复制路径', action: () => copyText(item.path) },
    '-',
    { label: '移除收藏', action: () => invoke('remove_favorite', { index }) },
  ]);
}

const samePath = (a, b) => a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase();

// ---------------------------------------------------------------------------
// 最近打开的文件
// ---------------------------------------------------------------------------
let recentLoading = false, recentQueued = false;
async function loadRecent() {
  if (recentLoading) { recentQueued = true; return; }
  recentLoading = true;
  const btn = $('#btn-refresh');
  btn.classList.add('spin');
  try {
    const items = await invoke('get_recent');
    const body = recentList.parentElement;
    const top = body.scrollTop;
    recentList.replaceChildren(...items.map(renderRecent));
    body.scrollTop = top;
    $('#recent-empty').classList.toggle('hidden', items.length > 0);
  } catch (e) {
    toast('读取最近文件失败：' + e, [], 3500);
  } finally {
    recentLoading = false;
    btn.classList.remove('spin');
    if (recentQueued) { recentQueued = false; loadRecent(); }
  }
}

function renderRecent(item) {
  const tile = makeTile(item, middleEllipsis(item.name), `${item.app} · ${fmtTime(item.time)}`);
  if (item.pinned) {
    const pin = document.createElement('span');
    pin.className = 'pin';
    pin.textContent = '★';
    pin.title = '已收藏置顶';
    tile.appendChild(pin);
  }
  tile.addEventListener('dblclick', () => openPath(item.path));
  tile.addEventListener('contextmenu', (e) => { e.preventDefault(); showRecentMenu(e, item); });
  enableDrag(tile, { kind: 'recent', item });
  return tile;
}

// ---------------------------------------------------------------------------
// 常用文件与文件夹
// ---------------------------------------------------------------------------
let favorites = [];

async function loadFavorites() {
  favorites = await invoke('get_favorites');
  favList.replaceChildren(...favorites.map(renderFavorite));
  $('#fav-empty').classList.toggle('hidden', favorites.length > 0);
}

function renderFavorite(item, index) {
  const sub = item.missing ? '已失效（找不到路径）' : item.isDir ? '文件夹' : (item.ext ? item.ext.toUpperCase() + ' 文件' : '文件');
  const tile = makeTile(item, middleEllipsis(item.name), sub);
  tile.dataset.index = index;
  if (item.missing) tile.classList.add('missing');
  tile.addEventListener('dblclick', () => !item.missing && openPath(item.path));
  tile.addEventListener('contextmenu', (e) => { e.preventDefault(); showFavoriteMenu(e, item, index); });
  enableDrag(tile, { kind: 'fav', item, index });
  return tile;
}

function startRename(index) {
  const tile = favList.querySelector(`.tile[data-index="${index}"]`);
  if (!tile) return;
  const nameEl = tile.querySelector('.name');
  const input = document.createElement('input');
  input.className = 'rename';
  input.value = favorites[index].name;
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (ok) => {
    if (done) return;
    done = true;
    if (ok) invoke('rename_favorite', { index, name: input.value });
    else loadFavorites();
  };
  input.addEventListener('pointerdown', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

// ---------------------------------------------------------------------------
// 拖拽（基于指针事件：常用内排序 / 最近 → 常用）
// ---------------------------------------------------------------------------
function clearMarkers() {
  favList.querySelectorAll('.drop-before,.drop-after').forEach((t) => t.classList.remove('drop-before', 'drop-after'));
}
function insideFavCard(x, y) {
  const r = favCard.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}
function dropIndexAt(x, y) {
  const tiles = [...favList.querySelectorAll('.tile')];
  for (const t of tiles) {
    const r = t.getBoundingClientRect();
    if (y < r.top) return { index: +t.dataset.index, tile: t, before: true };
    if (y <= r.bottom && x < r.left + r.width / 2) return { index: +t.dataset.index, tile: t, before: true };
    if (y <= r.bottom && x <= r.right) return { index: +t.dataset.index + 1, tile: t, before: false };
  }
  return { index: tiles.length, tile: tiles[tiles.length - 1], before: false };
}
function showDropHint(x, y, overlay) {
  clearMarkers();
  const inside = insideFavCard(x, y);
  favCard.classList.toggle(overlay ? 'drag-over' : 'drop-target', inside);
  if (inside && favorites.length) {
    const { tile, before } = dropIndexAt(x, y);
    if (tile) tile.classList.add(before ? 'drop-before' : 'drop-after');
  }
  return inside;
}

function enableDrag(tile, src) {
  let st = null;
  tile.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    st = { x: e.clientX, y: e.clientY, started: false, ghost: null, id: e.pointerId };
  });
  tile.addEventListener('pointermove', (e) => {
    if (!st) return;
    if (!st.started) {
      if (Math.hypot(e.clientX - st.x, e.clientY - st.y) < 6) return;
      st.started = true;
      tile.setPointerCapture(st.id);
      tile.classList.add('dragging');
      st.ghost = tile.cloneNode(true);
      st.ghost.classList.remove('dragging');
      st.ghost.classList.add('ghost');
      document.body.appendChild(st.ghost);
    }
    st.ghost.style.left = e.clientX + 10 + 'px';
    st.ghost.style.top = e.clientY + 6 + 'px';
    showDropHint(e.clientX, e.clientY, false);
  });
  const end = async (e, cancelled) => {
    if (!st) return;
    const s = st;
    st = null;
    if (!s.started) return;
    s.ghost.remove();
    tile.classList.remove('dragging');
    favCard.classList.remove('drop-target');
    clearMarkers();
    if (cancelled || !insideFavCard(e.clientX, e.clientY)) return;
    const { index } = dropIndexAt(e.clientX, e.clientY);
    if (src.kind === 'fav') {
      const to = index > src.index ? index - 1 : index;
      if (to !== src.index) await invoke('reorder_favorites', { from: src.index, to });
    } else {
      await invoke('add_favorites', { paths: [src.item.path], index });
    }
  };
  tile.addEventListener('pointerup', (e) => end(e, false));
  tile.addEventListener('pointercancel', (e) => end(e, true));
}

// 从资源管理器拖入文件 / 文件夹
currentWebview.onDragDropEvent((event) => {
  const { type, paths, position } = event.payload;
  const dpr = window.devicePixelRatio || 1;
  const x = position ? position.x / dpr : 0, y = position ? position.y / dpr : 0;
  if (type === 'enter' || type === 'over') {
    favCard.classList.add('drag-over');
    showDropHint(x, y, true);
    favCard.classList.add('drag-over'); // 拖入窗口任意位置都可收藏
  } else if (type === 'drop') {
    favCard.classList.remove('drag-over');
    clearMarkers();
    if (paths && paths.length) {
      const index = insideFavCard(x, y) ? dropIndexAt(x, y).index : null;
      invoke('add_favorites', { paths, index });
    }
  } else {
    favCard.classList.remove('drag-over');
    clearMarkers();
  }
});

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------
async function loadSettings() {
  settings = await invoke('get_settings');
  document.body.classList.remove('opacity-low', 'opacity-medium', 'opacity-high');
  document.body.classList.add(`opacity-${settings.opacity || 'medium'}`);
}

$('#btn-refresh').addEventListener('click', loadRecent);
$('#btn-add').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  const pick = async (directory) => {
    const res = await invoke('plugin:dialog|open', {
      options: { title: directory ? '添加文件夹到常用' : '添加文件到常用', multiple: true, directory },
    });
    const paths = Array.isArray(res) ? res : res ? [res] : [];
    if (paths.length) invoke('add_favorites', { paths, index: null });
  };
  showMenu(r.left - 60, r.bottom + 4, [
    { label: '添加文件…', action: () => pick(false) },
    { label: '添加文件夹…', action: () => pick(true) },
  ]);
});
$('#btn-menu').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  loadSettings().then(() => showAppMenu(r.right - 190, r.bottom + 4));
});

listen('recent-changed', loadRecent);
listen('favorites-changed', loadFavorites);
listen('settings-changed', loadSettings);

loadSettings();
loadRecent();
loadFavorites();

// ---------------------------------------------------------------------------
// 检查更新：读 GitHub 最新 Release，有新版本就用浏览器下载对应的安装包 / 便携版
// ---------------------------------------------------------------------------
const REPO = 'a221333/desktop-file-widget';
const newer = (a, b) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};
async function checkUpdate(manual = false) {
  try {
    if (!settings.version) await loadSettings();
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rel = await res.json();
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    if (!latest || !newer(latest, settings.version)) {
      if (manual) toast(`已是最新版本（${settings.version}）`);
      return;
    }
    if (!manual && localStorage.getItem('skipVersion') === latest) return;
    const name = `DesktopFileWidget-${settings.ocBuild ? 'OneCommander-' : ''}${latest}-${settings.installed ? 'setup' : 'portable'}.exe`;
    const asset = (rel.assets || []).find((a) => a.name === name);
    const url = asset ? asset.browser_download_url : rel.html_url;
    toast(`发现新版本 ${latest}${settings.installed ? '，下载后运行安装包即可覆盖升级，设置会保留' : '，下载后替换当前 exe 即可'}`, [
      { label: '下载', primary: true, action: () => invoke('open_url', { url }).catch((e) => toast(String(e))) },
      { label: '查看更新内容', action: () => invoke('open_url', { url: rel.html_url }) },
      { label: '跳过此版本', action: () => localStorage.setItem('skipVersion', latest) },
    ]);
  } catch (e) {
    if (manual) toast(`检查更新失败：${e.message || e}`);
  }
}
setTimeout(() => checkUpdate(false), 8000);
