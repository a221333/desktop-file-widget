/* global widget */
const $ = (s) => document.querySelector(s);
const recentList = $('#recent-list');
const favList = $('#fav-list');

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
function middleEllipsis(name, maxW = 24) {
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

// 系统图标获取失败时使用的彩色兜底图标
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
  const url = await widget.getIcon(item.path, item.isDir);
  if (url) {
    const img = new Image();
    img.src = url;
    img.draggable = false;
    el.replaceChildren(img);
  }
}

function makeTile(item, { title, sub }) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.title = item.path;
  const ico = document.createElement('div');
  ico.className = 'ico';
  const meta = document.createElement('div');
  meta.className = 'meta';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = title;
  const subEl = document.createElement('div');
  subEl.className = 'sub';
  subEl.textContent = sub;
  meta.append(name, subEl);
  tile.append(ico, meta);
  setIcon(ico, item);
  return tile;
}

// ---------------------------------------------------------------------------
// 最近打开的文件
// ---------------------------------------------------------------------------
let recentLoading = false;
async function loadRecent() {
  if (recentLoading) return;
  recentLoading = true;
  const btn = $('#btn-refresh');
  btn.classList.add('spin');
  try {
    const items = await widget.getRecent();
    const scrollTop = recentList.parentElement.scrollTop;
    recentList.replaceChildren(...items.map(renderRecent));
    recentList.parentElement.scrollTop = scrollTop;
    $('#recent-empty').classList.toggle('hidden', items.length > 0);
  } finally {
    recentLoading = false;
    btn.classList.remove('spin');
  }
}

function renderRecent(item) {
  const tile = makeTile(item, { title: middleEllipsis(item.name), sub: `${item.app} · ${fmtTime(item.time)}` });
  if (item.pinned) {
    const pin = document.createElement('span');
    pin.className = 'pin';
    pin.textContent = '★';
    pin.title = '已收藏置顶';
    tile.appendChild(pin);
  }
  tile.addEventListener('dblclick', () => widget.open(item.path));
  tile.addEventListener('contextmenu', (e) => { e.preventDefault(); widget.recentMenu({ path: item.path }); });
  // 可直接拖到下方“常用”卡片中收藏
  tile.draggable = true;
  tile.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('application/x-widget-recent', item.path);
    e.dataTransfer.effectAllowed = 'copy';
  });
  return tile;
}

// ---------------------------------------------------------------------------
// 常用文件与文件夹
// ---------------------------------------------------------------------------
let favorites = [];
let dragFrom = -1;

async function loadFavorites() {
  favorites = await widget.getFavorites();
  favList.replaceChildren(...favorites.map(renderFavorite));
  $('#fav-empty').classList.toggle('hidden', favorites.length > 0);
}

function renderFavorite(item, index) {
  const sub = item.missing ? '已失效（找不到路径）' : item.isDir ? '文件夹' : (item.ext ? item.ext.toUpperCase() + ' 文件' : '文件');
  const tile = makeTile(item, { title: middleEllipsis(item.name), sub });
  tile.dataset.index = index;
  if (item.missing) tile.classList.add('missing');
  tile.addEventListener('dblclick', () => !item.missing && widget.open(item.path));
  tile.addEventListener('contextmenu', (e) => { e.preventDefault(); widget.favoriteMenu(index); });

  // 拖拽排序
  tile.draggable = true;
  tile.addEventListener('dragstart', (e) => {
    dragFrom = index;
    tile.classList.add('dragging');
    e.dataTransfer.setData('application/x-widget-fav', String(index));
    e.dataTransfer.effectAllowed = 'move';
  });
  tile.addEventListener('dragend', () => { dragFrom = -1; tile.classList.remove('dragging'); clearMarkers(); });
  return tile;
}

function clearMarkers() {
  favList.querySelectorAll('.drop-before,.drop-after').forEach((t) => t.classList.remove('drop-before', 'drop-after'));
}

// 根据鼠标位置计算插入位置
function dropIndexAt(e) {
  const tiles = [...favList.querySelectorAll('.tile')];
  for (const t of tiles) {
    const r = t.getBoundingClientRect();
    if (e.clientY < r.top) return { index: +t.dataset.index, tile: t, before: true };
    if (e.clientY <= r.bottom && e.clientX < r.left + r.width / 2) return { index: +t.dataset.index, tile: t, before: true };
    if (e.clientY <= r.bottom && e.clientX <= r.right) return { index: +t.dataset.index + 1, tile: t, before: false };
  }
  const last = tiles[tiles.length - 1];
  return { index: tiles.length, tile: last, before: false };
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
    if (ok) widget.renameFavorite(index, input.value);
    else loadFavorites();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

// 卡片级拖放：外部文件 / 最近文件 / 内部排序
const favCard = $('#fav-card');
let dragDepth = 0;
const isExternal = (e) => [...e.dataTransfer.types].includes('Files');
const isRecent = (e) => [...e.dataTransfer.types].includes('application/x-widget-recent');

favCard.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  if (isExternal(e) || isRecent(e)) favCard.classList.add('drag-over');
});
favCard.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; favCard.classList.remove('drag-over'); clearMarkers(); }
});
favCard.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = dragFrom >= 0 ? 'move' : 'copy';
  clearMarkers();
  if (favorites.length && (dragFrom >= 0 || isExternal(e) || isRecent(e))) {
    const { tile, before } = dropIndexAt(e);
    if (tile) tile.classList.add(before ? 'drop-before' : 'drop-after');
  }
});
favCard.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  favCard.classList.remove('drag-over');
  clearMarkers();
  const { index } = dropIndexAt(e);

  if (dragFrom >= 0) {
    const to = index > dragFrom ? index - 1 : index;
    if (to !== dragFrom) await widget.reorderFavorites(dragFrom, to);
    dragFrom = -1;
    return;
  }
  const recentPath = e.dataTransfer.getData('application/x-widget-recent');
  if (recentPath) return widget.addFavorites([recentPath], index);

  const paths = [...e.dataTransfer.files].map((f) => widget.pathForFile(f)).filter(Boolean);
  if (paths.length) widget.addFavorites(paths, index);
});

// 阻止把文件拖到其它区域时窗口跳转
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------
function applySettings(s) {
  document.body.classList.remove('opacity-low', 'opacity-medium', 'opacity-high');
  document.body.classList.add(`opacity-${s.opacity || 'medium'}`);
}

$('#btn-refresh').addEventListener('click', loadRecent);
$('#btn-add').addEventListener('click', () => widget.pickFavorites());
$('#btn-menu').addEventListener('click', () => widget.appMenu());

widget.onRecentChanged(loadRecent);
widget.onFavoritesChanged(loadFavorites);
widget.onSettingsChanged(applySettings);
widget.onRenameFavorite(startRename);

widget.getSettings().then(applySettings);
loadRecent();
loadFavorites();
