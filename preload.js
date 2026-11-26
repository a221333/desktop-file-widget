const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel, cb) => ipcRenderer.on(channel, (_e, payload) => cb(payload));

contextBridge.exposeInMainWorld('widget', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  getRecent: () => ipcRenderer.invoke('get-recent'),
  getFavorites: () => ipcRenderer.invoke('get-favorites'),
  getIcon: (p, isDir) => ipcRenderer.invoke('get-icon', p, isDir),
  open: (p) => ipcRenderer.invoke('open', p),
  reveal: (p) => ipcRenderer.invoke('reveal', p),
  addFavorites: (paths, index) => ipcRenderer.invoke('add-favorites', paths, index),
  reorderFavorites: (from, to) => ipcRenderer.invoke('reorder-favorites', from, to),
  pickFavorites: () => ipcRenderer.invoke('pick-favorites'),
  recentMenu: (item) => ipcRenderer.invoke('recent-menu', item),
  favoriteMenu: (index) => ipcRenderer.invoke('favorite-menu', index),
  renameFavorite: (index, name) => ipcRenderer.invoke('rename-favorite', index, name),
  appMenu: () => ipcRenderer.invoke('app-menu'),
  hide: () => ipcRenderer.invoke('hide'),
  // Electron 32+ 移除了 File.path，需要通过 webUtils 获取拖入文件的真实路径
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return file.path || ''; }
  },
  onRecentChanged: (cb) => on('recent-changed', cb),
  onFavoritesChanged: (cb) => on('favorites-changed', cb),
  onSettingsChanged: (cb) => on('settings-changed', cb),
  onRenameFavorite: (cb) => on('rename-favorite', cb),
});
