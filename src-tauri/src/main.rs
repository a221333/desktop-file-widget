// 桌面文件小组件（Tauri 版）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(windows)]
mod win;

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow, WindowEvent};
use tauri_plugin_autostart::ManagerExt;

const IS_OC_BUILD: bool = cfg!(feature = "onecommander");

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
#[derive(Serialize, Deserialize, Clone, Default)]
struct Favorite {
    path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Copy)]
struct Bounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Serialize, Deserialize, Clone)]
struct Tracked {
    path: String,
    time: f64, // 毫秒时间戳
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default, rename_all = "camelCase")]
struct Config {
    favorites: Vec<Favorite>,
    pinned: Vec<String>,
    hidden: Vec<String>,
    bounds: Option<Bounds>,
    always_on_top: bool,
    opacity: String,
    max_recent: usize,
    include_folders: bool,
    single_column: bool,
    use_one_commander: bool,
    oc_path: Option<String>,
    /// 记录从 OneCommander 打开的文件（OneCommander 不会写入系统“最近”）
    track_one_commander: bool,
    tracked_recent: Vec<Tracked>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            favorites: vec![],
            pinned: vec![],
            hidden: vec![],
            bounds: None,
            always_on_top: false,
            opacity: "medium".into(),
            max_recent: 40,
            include_folders: false,
            single_column: false,
            use_one_commander: IS_OC_BUILD,
            oc_path: None,
            track_one_commander: IS_OC_BUILD,
            tracked_recent: vec![],
        }
    }
}


struct AppState {
    cfg: Mutex<Config>,
    cfg_path: PathBuf,
    dirty: AtomicBool,
    lnk_cache: Mutex<HashMap<PathBuf, (SystemTime, Option<String>)>>,
    app_names: Mutex<HashMap<String, String>>,
    icons: Mutex<HashMap<String, Option<String>>>,
}

type St<'a> = State<'a, Arc<AppState>>;

impl AppState {
    fn cfg(&self) -> std::sync::MutexGuard<'_, Config> {
        self.cfg.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn mark_dirty(&self) {
        self.dirty.store(true, Ordering::SeqCst);
    }
    fn save_now(&self) {
        if !self.dirty.swap(false, Ordering::SeqCst) {
            return;
        }
        let json = serde_json::to_string_pretty(&*self.cfg()).unwrap_or_default();
        if let Some(dir) = self.cfg_path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let tmp = self.cfg_path.with_extension("json.tmp");
        if fs::write(&tmp, json).is_ok() {
            let _ = fs::rename(&tmp, &self.cfg_path);
        }
    }
}

fn norm(p: &str) -> String {
    if cfg!(windows) {
        p.replace('/', "\\").trim_end_matches('\\').to_lowercase()
    } else {
        p.trim_end_matches('/').to_string()
    }
}
fn same(a: &str, b: &str) -> bool {
    norm(a) == norm(b)
}
fn ms(t: SystemTime) -> f64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}
fn ext_of(p: &str) -> String {
    Path::new(p).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}
fn base_name(p: &str) -> String {
    Path::new(p).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.to_string())
}

// ---------------------------------------------------------------------------
// 打开方式名称
// ---------------------------------------------------------------------------
fn prog_id_to_name(prog: &str) -> Option<String> {
    let p = prog.to_lowercase();
    let starts = |s: &str| p.starts_with(s);
    let name = if starts("kwps.") || starts("ket.") || starts("kwpp.") || p.contains("wps") || p.contains("kingsoft") {
        "WPS"
    } else if starts("word.") {
        "Word"
    } else if starts("excel.") {
        "Excel"
    } else if starts("powerpoint.") {
        "PowerPoint"
    } else if p.contains("acro") {
        "Acrobat"
    } else if p.contains("msedge") {
        "Edge"
    } else if p.contains("chrome") {
        "Chrome"
    } else if p.contains("firefox") {
        "Firefox"
    } else if p.contains("foxit") {
        "Foxit"
    } else if p.contains("sumatra") {
        "Sumatra"
    } else if p.contains("vscode") {
        "VS Code"
    } else if p.contains("photos") {
        "照片"
    } else if p.contains("obsidian") {
        "Obsidian"
    } else if let Some(i) = p.find("applications\\") {
        let rest = &prog[i + 13..];
        return Some(rest.trim_end_matches(".exe").trim_end_matches(".EXE").to_string());
    } else {
        return None;
    };
    Some(name.to_string())
}

fn type_label(ext: &str) -> String {
    match ext {
        "doc" | "docx" | "wps" | "rtf" => "文档",
        "txt" | "md" => "文本",
        "xls" | "xlsx" | "et" | "csv" => "表格",
        "ppt" | "pptx" | "dps" => "演示",
        "pdf" => "PDF",
        "ofd" => "OFD",
        "jpg" | "jpeg" | "png" | "gif" | "bmp" | "webp" => "图片",
        "mp4" | "mkv" | "avi" | "mov" => "视频",
        "mp3" | "wav" | "flac" => "音频",
        "zip" | "rar" | "7z" => "压缩包",
        "" => "文件",
        other => return other.to_uppercase(),
    }
    .to_string()
}

fn app_name(state: &AppState, ext: &str) -> String {
    if let Some(n) = state.app_names.lock().unwrap().get(ext) {
        return n.clone();
    }
    #[allow(unused_mut)]
    let mut name: Option<String> = None;
    #[cfg(windows)]
    if !ext.is_empty() {
        name = win::default_app_prog_id(ext).and_then(|p| prog_id_to_name(&p));
    }
    let _ = prog_id_to_name; // 非 Windows 平台避免未使用警告
    let name = name.unwrap_or_else(|| type_label(ext));
    state.app_names.lock().unwrap().insert(ext.to_string(), name.clone());
    name
}

// ---------------------------------------------------------------------------
// 最近打开的文件
// ---------------------------------------------------------------------------
struct RawRecent {
    path: String,
    time: SystemTime,
}

#[cfg(windows)]
fn recent_dir() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("Microsoft\\Windows\\Recent"))
}

#[cfg(windows)]
fn raw_recent(state: &AppState) -> Vec<RawRecent> {
    let Some(dir) = recent_dir() else { return vec![] };
    let Ok(rd) = fs::read_dir(&dir) else { return vec![] };
    let mut cache = state.lnk_cache.lock().unwrap();
    let mut seen = HashSet::new();
    let mut out = vec![];
    for e in rd.flatten() {
        let p = e.path();
        if ext_of(&p.to_string_lossy()) != "lnk" {
            continue;
        }
        let Ok(mtime) = e.metadata().and_then(|m| m.modified()) else { continue };
        seen.insert(p.clone());
        let target = match cache.get(&p) {
            Some((t, target)) if *t == mtime => target.clone(),
            _ => {
                let target = win::resolve_lnk(&p);
                cache.insert(p.clone(), (mtime, target.clone()));
                target
            }
        };
        if let Some(path) = target {
            out.push(RawRecent { path, time: mtime });
        }
    }
    cache.retain(|k, _| seen.contains(k));
    out
}

// 非 Windows（开发调试用）：读取 recently-used.xbel
#[cfg(not(windows))]
fn raw_recent(_state: &AppState) -> Vec<RawRecent> {
    let Some(home) = std::env::var_os("HOME") else { return vec![] };
    let file = PathBuf::from(home).join(".local/share/recently-used.xbel");
    let Ok(xml) = fs::read_to_string(file) else { return vec![] };
    let mut out = vec![];
    for chunk in xml.split("<bookmark ").skip(1) {
        let Some(start) = chunk.find("href=\"file://") else { continue };
        let rest = &chunk[start + 13..];
        let Some(end) = rest.find('"') else { continue };
        let path = percent_decode(&rest[..end]);
        let time = fs::metadata(&path).and_then(|m| m.modified()).unwrap_or(UNIX_EPOCH);
        out.push(RawRecent { path, time });
    }
    out
}
#[cfg(not(windows))]
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Item {
    path: String,
    name: String,
    ext: String,
    is_dir: bool,
    time: f64,
    app: String,
    pinned: bool,
    missing: bool,
}

fn build_recent(state: &AppState) -> Vec<Item> {
    let mut raw = raw_recent(state);
    // 合并从 OneCommander 打开并被记录下来的文件
    for t in state.cfg().tracked_recent.iter() {
        raw.push(RawRecent { path: t.path.clone(), time: UNIX_EPOCH + Duration::from_millis(t.time as u64) });
    }
    raw.sort_by(|a, b| b.time.cmp(&a.time));
    let (hidden, pinned, include_folders, max) = {
        let c = state.cfg();
        (
            c.hidden.iter().map(|h| norm(h)).collect::<HashSet<_>>(),
            c.pinned.clone(),
            c.include_folders,
            c.max_recent,
        )
    };
    let pinned_set: HashSet<String> = pinned.iter().map(|p| norm(p)).collect();
    let mut seen = HashSet::new();
    let mut list: Vec<(String, SystemTime, bool)> = vec![];
    for r in raw {
        let key = norm(&r.path);
        if seen.contains(&key) || hidden.contains(&key) || pinned_set.contains(&key) {
            continue;
        }
        let Ok(meta) = fs::metadata(&r.path) else { continue };
        if meta.is_dir() && !include_folders {
            continue;
        }
        seen.insert(key);
        list.push((r.path, r.time, meta.is_dir()));
        if list.len() >= max {
            break;
        }
    }
    let mut items = vec![];
    for p in &pinned {
        let Ok(meta) = fs::metadata(p) else { continue };
        let t = meta.modified().unwrap_or(UNIX_EPOCH);
        items.push((p.clone(), t, meta.is_dir(), true));
    }
    items.extend(list.into_iter().map(|(p, t, d)| (p, t, d, false)));
    items
        .into_iter()
        .map(|(path, t, is_dir, pinned)| {
            let ext = if is_dir { String::new() } else { ext_of(&path) };
            Item {
                name: base_name(&path),
                app: if is_dir { "文件夹".into() } else { app_name(state, &ext) },
                ext,
                is_dir,
                time: ms(t),
                pinned,
                missing: false,
                path,
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------
fn emit(app: &AppHandle, ev: &str) {
    let _ = app.emit(ev, ());
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    opacity: String,
    always_on_top: bool,
    auto_start: bool,
    include_folders: bool,
    single_column: bool,
    hidden_count: usize,
    oc_build: bool,
    use_one_commander: bool,
    track_one_commander: bool,
    oc_path: Option<String>,
    version: String,
    installed: bool,
}

/// 安装版的 exe 旁边有 NSIS 生成的 uninstall.exe；便携版没有
fn is_installed() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("uninstall.exe").is_file()))
        .unwrap_or(false)
}

#[tauri::command]
fn get_settings(app: AppHandle, state: St) -> Settings {
    let c = state.cfg();
    Settings {
        opacity: c.opacity.clone(),
        always_on_top: c.always_on_top,
        auto_start: app.autolaunch().is_enabled().unwrap_or(false),
        include_folders: c.include_folders,
        single_column: c.single_column,
        hidden_count: c.hidden.len(),
        oc_build: IS_OC_BUILD,
        use_one_commander: c.use_one_commander,
        track_one_commander: c.track_one_commander,
        oc_path: c.oc_path.clone(),
        version: app.package_info().version.to_string(),
        installed: is_installed(),
    }
}

/// 用默认浏览器打开更新链接（只允许本项目的 GitHub 地址）
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://github.com/a221333/desktop-file-widget/") {
        return Err("不允许的链接".into());
    }
    tauri_plugin_opener::open_url(&url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_setting(app: AppHandle, state: St, key: String, value: Value) -> Result<(), String> {
    {
        let mut c = state.cfg();
        match key.as_str() {
            "opacity" => c.opacity = value.as_str().unwrap_or("medium").to_string(),
            "alwaysOnTop" => {
                c.always_on_top = value.as_bool().unwrap_or(false);
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.set_always_on_top(c.always_on_top);
                }
            }
            "includeFolders" => c.include_folders = value.as_bool().unwrap_or(false),
            "singleColumn" => c.single_column = value.as_bool().unwrap_or(false),
            "useOneCommander" => c.use_one_commander = value.as_bool().unwrap_or(false),
            "trackOneCommander" => c.track_one_commander = value.as_bool().unwrap_or(false),
            "ocPath" => c.oc_path = value.as_str().filter(|s| !s.is_empty()).map(String::from),
            "autoStart" => {
                let al = app.autolaunch();
                let r = if value.as_bool().unwrap_or(false) { al.enable() } else { al.disable() };
                r.map_err(|e| e.to_string())?;
            }
            _ => return Err(format!("unknown setting {key}")),
        }
    }
    state.mark_dirty();
    emit(&app, "settings-changed");
    if key == "includeFolders" {
        emit(&app, "recent-changed");
    }
    Ok(())
}

#[tauri::command]
async fn get_recent(state: St<'_>) -> Result<Vec<Item>, String> {
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || build_recent(&s)).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn get_favorites(state: St) -> Vec<Item> {
    state
        .cfg()
        .favorites
        .iter()
        .map(|f| {
            let meta = fs::metadata(&f.path).ok();
            let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
            Item {
                path: f.path.clone(),
                name: f.name.clone().unwrap_or_else(|| base_name(&f.path)),
                ext: if is_dir { String::new() } else { ext_of(&f.path) },
                is_dir,
                time: 0.0,
                app: String::new(),
                pinned: false,
                missing: meta.is_none(),
            }
        })
        .collect()
}

#[tauri::command]
async fn get_icon(state: St<'_>, path: String, is_dir: bool) -> Result<Option<String>, String> {
    let ext = ext_of(&path);
    let per_file = is_dir || ext.is_empty() || matches!(ext.as_str(), "exe" | "lnk" | "ico" | "url" | "appref-ms");
    let key = if per_file { format!("p:{}", norm(&path)) } else { format!("e:{ext}") };
    if let Some(v) = state.icons.lock().unwrap().get(&key) {
        return Ok(v.clone());
    }
    let s = state.inner().clone();
    let url = tauri::async_runtime::spawn_blocking(move || icon_data_url(&path, is_dir))
        .await
        .map_err(|e| e.to_string())?;
    s.icons.lock().unwrap().insert(key, url.clone());
    Ok(url)
}

#[cfg(windows)]
fn icon_data_url(path: &str, is_dir: bool) -> Option<String> {
    use base64::Engine;
    let exists = Path::new(path).exists();
    let (w, h, rgba) = win::file_icon_rgba(path, is_dir, exists)?;
    let mut png_bytes = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut png_bytes, w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().ok()?;
        writer.write_image_data(&rgba).ok()?;
    }
    Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png_bytes)))
}
#[cfg(not(windows))]
fn icon_data_url(_path: &str, _is_dir: bool) -> Option<String> {
    None // 前端使用彩色兜底图标
}

// ---- 打开 / 定位 ----
fn oc_exe(state: &AppState) -> Option<String> {
    let saved = state.cfg().oc_path.clone();
    if let Some(p) = saved.filter(|p| Path::new(p).is_file()) {
        return Some(p);
    }
    #[cfg(windows)]
    if let Some(found) = win::find_one_commander() {
        state.cfg().oc_path = Some(found.clone());
        state.mark_dirty();
        return Some(found);
    }
    None
}

fn use_oc(state: &AppState) -> bool {
    IS_OC_BUILD && state.cfg().use_one_commander
}

fn open_in_oc(state: &AppState, dir: &str) -> Result<(), String> {
    let exe = oc_exe(state).ok_or_else(|| "OC_NOT_FOUND".to_string())?;
    #[cfg(windows)]
    return win::launch(&exe, dir).map_err(|e| format!("启动 OneCommander 失败：{e}"));
    #[cfg(not(windows))]
    {
        let _ = (exe, dir);
        Err("OC_NOT_FOUND".into())
    }
}

/// 打开文件 / 文件夹。force_system = true 时忽略 OneCommander 设置
#[tauri::command]
async fn open_path(state: St<'_>, path: String, force_system: Option<bool>) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err("路径不存在或已被移动".into());
    }
    let s = state.inner().clone();
    let force = force_system.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        if p_is_dir(&path) && !force && use_oc(&s) {
            return open_in_oc(&s, &path);
        }
        tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
fn p_is_dir(p: &str) -> bool {
    Path::new(p).is_dir()
}

/// 定位文件：普通版用资源管理器选中；OneCommander 版打开其所在文件夹
#[tauri::command]
async fn reveal(state: St<'_>, path: String, force_system: Option<bool>) -> Result<(), String> {
    let s = state.inner().clone();
    let force = force_system.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        if !force && use_oc(&s) {
            let dir = Path::new(&path)
                .parent()
                .map(|d| d.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.clone());
            return open_in_oc(&s, &dir);
        }
        tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- 收藏 / 置顶 ----
#[tauri::command]
fn add_favorites(app: AppHandle, state: St, paths: Vec<String>, index: Option<usize>) {
    {
        let mut c = state.cfg();
        let mut fresh: Vec<Favorite> = vec![];
        for p in paths {
            if p.is_empty() || c.favorites.iter().any(|f| same(&f.path, &p)) || fresh.iter().any(|f| same(&f.path, &p)) {
                continue;
            }
            fresh.push(Favorite { path: p, name: None });
        }
        if fresh.is_empty() {
            return;
        }
        let at = index.unwrap_or(c.favorites.len()).min(c.favorites.len());
        c.favorites.splice(at..at, fresh);
    }
    state.mark_dirty();
    emit(&app, "favorites-changed");
}

#[tauri::command]
fn reorder_favorites(app: AppHandle, state: St, from: usize, to: usize) {
    {
        let mut c = state.cfg();
        if from >= c.favorites.len() {
            return;
        }
        let item = c.favorites.remove(from);
        let to = to.min(c.favorites.len());
        c.favorites.insert(to, item);
    }
    state.mark_dirty();
    emit(&app, "favorites-changed");
}

#[tauri::command]
fn remove_favorite(app: AppHandle, state: St, index: usize) {
    {
        let mut c = state.cfg();
        if index < c.favorites.len() {
            c.favorites.remove(index);
        }
    }
    state.mark_dirty();
    emit(&app, "favorites-changed");
}

#[tauri::command]
fn rename_favorite(app: AppHandle, state: St, index: usize, name: String) {
    {
        let mut c = state.cfg();
        if let Some(f) = c.favorites.get_mut(index) {
            let n = name.trim();
            f.name = if n.is_empty() || n == base_name(&f.path) { None } else { Some(n.to_string()) };
        }
    }
    state.mark_dirty();
    emit(&app, "favorites-changed");
}

#[tauri::command]
fn set_pinned(app: AppHandle, state: St, path: String, pinned: bool) {
    {
        let mut c = state.cfg();
        c.pinned.retain(|p| !same(p, &path));
        if pinned {
            c.pinned.insert(0, path);
        }
    }
    state.mark_dirty();
    emit(&app, "recent-changed");
}

#[tauri::command]
fn hide_recent(app: AppHandle, state: St, path: String) {
    {
        let mut c = state.cfg();
        c.pinned.retain(|p| !same(p, &path));
        c.tracked_recent.retain(|t| !same(&t.path, &path));
        c.hidden.push(path);
    }
    state.mark_dirty();
    emit(&app, "recent-changed");
    emit(&app, "settings-changed");
}

#[tauri::command]
fn restore_hidden(app: AppHandle, state: St) {
    state.cfg().hidden.clear();
    state.mark_dirty();
    emit(&app, "recent-changed");
    emit(&app, "settings-changed");
}

// ---- 窗口 ----
#[tauri::command]
fn hide_window(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

#[tauri::command]
fn reset_position(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        place_default(&w);
        let _ = w.show();
    }
}

#[tauri::command]
fn quit(app: AppHandle, state: St) {
    state.mark_dirty();
    state.save_now();
    app.exit(0);
}

fn place_default(w: &WebviewWindow) {
    let Ok(Some(m)) = w.primary_monitor() else { return };
    let scale = m.scale_factor();
    let wa = m.work_area();
    let width = (470.0 * scale) as u32;
    let height = (660.0 * scale) as u32;
    let margin = (24.0 * scale) as i32;
    let _ = w.set_size(PhysicalSize::new(width, height));
    let _ = w.set_position(PhysicalPosition::new(
        wa.position.x + wa.size.width as i32 - width as i32 - margin,
        wa.position.y + margin,
    ));
}

fn bounds_visible(w: &WebviewWindow, b: &Bounds) -> bool {
    w.available_monitors()
        .map(|ms| {
            ms.iter().any(|m| {
                let wa = m.work_area();
                let (mx, my) = (wa.position.x, wa.position.y);
                let (mw, mh) = (wa.size.width as i32, wa.size.height as i32);
                b.x < mx + mw - 40 && b.x + b.width as i32 > mx + 40 && b.y >= my - 10 && b.y < my + mh - 40
            })
        })
        .unwrap_or(false)
}

fn toggle_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let cfg_path = app.path().app_config_dir()?.join("config.json");
            let cfg: Config = fs::read_to_string(&cfg_path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();
            let state = Arc::new(AppState {
                cfg: Mutex::new(cfg),
                cfg_path,
                dirty: AtomicBool::new(false),
                lnk_cache: Mutex::new(HashMap::new()),
                app_names: Mutex::new(HashMap::new()),
                icons: Mutex::new(HashMap::new()),
            });
            app.manage(state.clone());

            // 窗口位置 / 置顶
            let w = app.get_webview_window("main").expect("main window");
            let (bounds, top) = {
                let c = state.cfg();
                (c.bounds, c.always_on_top)
            };
            match bounds.filter(|b| bounds_visible(&w, b)) {
                Some(b) => {
                    let _ = w.set_size(PhysicalSize::new(b.width, b.height));
                    let _ = w.set_position(PhysicalPosition::new(b.x, b.y));
                }
                None => place_default(&w),
            }
            let _ = w.set_always_on_top(top);
            let _ = w.show();

            {
                let st = state.clone();
                let handle = app.handle().clone();
                w.on_window_event(move |ev| match ev {
                    WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                        if let Some(win) = handle.get_webview_window("main") {
                            if win.is_minimized().unwrap_or(false) {
                                return;
                            }
                            if let (Ok(p), Ok(s)) = (win.outer_position(), win.outer_size()) {
                                st.cfg().bounds = Some(Bounds { x: p.x, y: p.y, width: s.width, height: s.height });
                                st.mark_dirty();
                            }
                        }
                    }
                    WindowEvent::Focused(true) => emit(&handle, "recent-changed"),
                    WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        if let Some(win) = handle.get_webview_window("main") {
                            let _ = win.hide();
                        }
                    }
                    _ => {}
                });
            }

            // 托盘
            let show = MenuItem::with_id(app, "toggle", "显示 / 隐藏", true, None::<&str>)?;
            let reset = MenuItem::with_id(app, "reset", "重置窗口位置", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&show, &reset, &sep, &quit_i])?;
            let title = if IS_OC_BUILD { "桌面文件小组件（OneCommander 版）" } else { "桌面文件小组件" };
            let mut tray = TrayIconBuilder::with_id("main")
                .tooltip(title)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, ev| match ev.id().as_ref() {
                    "toggle" => toggle_window(app),
                    "reset" => {
                        if let Some(w) = app.get_webview_window("main") {
                            place_default(&w);
                            let _ = w.show();
                        }
                    }
                    "quit" => {
                        if let Some(s) = app.try_state::<Arc<AppState>>() {
                            s.mark_dirty();
                            s.save_now();
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, ev| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                        toggle_window(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            // 后台：记录从 OneCommander 打开的文件（仅特供版）
            #[cfg(windows)]
            if IS_OC_BUILD {
                let st = state.clone();
                let handle = app.handle().clone();
                std::thread::spawn(move || oc_tracker(st, handle));
            }

            // 后台：定时保存配置
            {
                let st = state.clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(Duration::from_millis(800));
                    st.save_now();
                });
            }

            // 后台：监测系统“最近”目录变化（每 3 秒检查一次），每分钟强制刷新
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let mut last = recent_signature();
                    let mut ticks = 0u32;
                    loop {
                        std::thread::sleep(Duration::from_secs(3));
                        ticks += 1;
                        let sig = recent_signature();
                        if sig != last || ticks >= 20 {
                            last = sig;
                            ticks = 0;
                            emit(&handle, "recent-changed");
                        }
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            open_url,
            set_setting,
            get_recent,
            get_favorites,
            get_icon,
            open_path,
            reveal,
            add_favorites,
            reorder_favorites,
            remove_favorite,
            rename_favorite,
            set_pinned,
            hide_recent,
            restore_hidden,
            hide_window,
            reset_position,
            quit
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 最近目录签名：文件数量 + 最新修改时间
fn recent_signature() -> (usize, u128) {
    #[cfg(windows)]
    let dir = recent_dir();
    #[cfg(not(windows))]
    let dir: Option<PathBuf> = std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share"));
    let Some(dir) = dir else { return (0, 0) };
    let Ok(rd) = fs::read_dir(dir) else { return (0, 0) };
    let mut n = 0;
    let mut latest = 0u128;
    for e in rd.flatten() {
        n += 1;
        if let Ok(t) = e.metadata().and_then(|m| m.modified()) {
            latest = latest.max(t.duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
        }
    }
    (n, latest)
}

// ---------------------------------------------------------------------------
// OneCommander 打开记录
// OneCommander 打开文件时不会写入系统“最近”列表（没有调用 SHAddToRecentDocs）。
// 这里监测由 OneCommander 启动的子进程，从命令行中取出被打开的文件并记录下来。
// OneCommander 在前台（或刚离开前台 4 秒内）时每 150ms 检查一次，其余时间每 2 秒一次。
// ---------------------------------------------------------------------------
#[cfg(windows)]
fn oc_tracker(state: Arc<AppState>, app: AppHandle) {
    use std::time::Instant;
    const SKIP_EXT: [&str; 6] = ["exe", "com", "msi", "dll", "sys", "lnk"];

    let mut seen: HashSet<u32> = win::process_snapshot().into_iter().map(|p| p.pid).collect();
    let mut oc_pids: HashSet<u32> = HashSet::new();
    let mut last_active: Option<Instant> = None;
    let mut last_scan = Instant::now() - Duration::from_secs(10);

    loop {
        if !state.cfg().track_one_commander {
            std::thread::sleep(Duration::from_secs(2));
            continue;
        }
        let fg_is_oc = win::foreground_pid().map(|p| oc_pids.contains(&p)).unwrap_or(false);
        if fg_is_oc {
            last_active = Some(Instant::now());
        }
        let active = last_active.map(|t| t.elapsed() < Duration::from_secs(4)).unwrap_or(false);
        let interval = if active { Duration::from_millis(150) } else { Duration::from_secs(2) };

        if active || last_scan.elapsed() >= Duration::from_secs(2) {
            last_scan = Instant::now();
            let procs = win::process_snapshot();
            oc_pids = procs.iter().filter(|p| p.exe == "onecommander.exe").map(|p| p.pid).collect();
            let mut found: Vec<String> = vec![];
            for p in &procs {
                if !seen.insert(p.pid) || !oc_pids.contains(&p.ppid) {
                    continue;
                }
                let Some(cmd) = win::process_command_line(p.pid) else { continue };
                for arg in win::split_command_line(&cmd).into_iter().skip(1) {
                    let arg = arg.trim().trim_matches('"').to_string();
                    if arg.len() < 4 || !(arg.contains(":\\") || arg.starts_with("\\\\")) {
                        continue;
                    }
                    let path = Path::new(&arg);
                    if !path.is_file() || SKIP_EXT.contains(&ext_of(&arg).as_str()) {
                        continue;
                    }
                    found.push(arg);
                }
            }
            // 清理已退出的进程
            let alive: HashSet<u32> = procs.iter().map(|p| p.pid).collect();
            seen.retain(|pid| alive.contains(pid));

            if !found.is_empty() {
                let now = ms(SystemTime::now());
                {
                    let mut c = state.cfg();
                    for f in found {
                        c.tracked_recent.retain(|t| !same(&t.path, &f));
                        c.hidden.retain(|h| !same(h, &f)); // 重新打开过的文件不再隐藏
                        c.tracked_recent.insert(0, Tracked { path: f, time: now });
                    }
                    c.tracked_recent.truncate(200);
                }
                state.mark_dirty();
                emit(&app, "recent-changed");
            }
        }
        std::thread::sleep(interval);
    }
}
