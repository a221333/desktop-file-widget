//! Windows 平台相关：解析 .lnk、提取系统文件图标、查询默认打开程序、查找 OneCommander
#![cfg(windows)]

use std::ffi::c_void;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use windows::core::{Interface, HSTRING};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
};
use windows::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, IPersistFile, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
    STGM_READ,
};
use windows::Win32::UI::Shell::{
    IShellLinkW, SHGetFileInfoW, ShellLink, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON,
    SHGFI_USEFILEATTRIBUTES,
};
use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, ICONINFO};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn com_init() {
    // 已在其它模式下初始化时会返回错误，忽略即可（COM 依然可用）
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }
}

/// 解析 .lnk 快捷方式的目标路径（支持中文等 Unicode 路径）
pub fn resolve_lnk(lnk: &Path) -> Option<String> {
    com_init();
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        let pf: IPersistFile = link.cast().ok()?;
        pf.Load(&HSTRING::from(lnk.as_os_str()), STGM_READ).ok()?;
        let mut buf = [0u16; 1024];
        link.GetPath(&mut buf, std::ptr::null_mut(), 0).ok()?;
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        if len == 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buf[..len]))
    }
}

/// 获取系统图标（32x32），返回 RGBA 像素
pub fn file_icon_rgba(path: &str, is_dir: bool, exists: bool) -> Option<(u32, u32, Vec<u8>)> {
    com_init();
    unsafe {
        let mut info = SHFILEINFOW::default();
        let mut flags = SHGFI_ICON | SHGFI_LARGEICON;
        if !exists {
            flags |= SHGFI_USEFILEATTRIBUTES;
        }
        let attrs = if is_dir { FILE_ATTRIBUTE_DIRECTORY } else { FILE_ATTRIBUTE_NORMAL };
        let r = SHGetFileInfoW(
            &HSTRING::from(path),
            attrs,
            Some(&mut info),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            flags,
        );
        if r == 0 || info.hIcon.is_invalid() {
            return None;
        }
        let hicon = info.hIcon;
        let result = icon_to_rgba(hicon);
        let _ = DestroyIcon(hicon);
        result
    }
}

unsafe fn icon_to_rgba(hicon: windows::Win32::UI::WindowsAndMessaging::HICON) -> Option<(u32, u32, Vec<u8>)> {
    let mut ii = ICONINFO::default();
    GetIconInfo(hicon, &mut ii).ok()?;
    let cleanup = |ii: &ICONINFO| {
        if !ii.hbmColor.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(ii.hbmColor.0));
        }
        if !ii.hbmMask.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(ii.hbmMask.0));
        }
    };
    if ii.hbmColor.is_invalid() {
        cleanup(&ii);
        return None;
    }
    let mut bm = BITMAP::default();
    if GetObjectW(
        HGDIOBJ(ii.hbmColor.0),
        std::mem::size_of::<BITMAP>() as i32,
        Some(&mut bm as *mut _ as *mut c_void),
    ) == 0
    {
        cleanup(&ii);
        return None;
    }
    let (w, h) = (bm.bmWidth, bm.bmHeight);
    let mut bi = BITMAPINFO::default();
    bi.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: w,
        biHeight: -h, // 自上而下
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        ..Default::default()
    };
    let mut buf = vec![0u8; (w * h * 4) as usize];
    let hdc = CreateCompatibleDC(None);
    let lines = GetDIBits(
        hdc,
        ii.hbmColor,
        0,
        h as u32,
        Some(buf.as_mut_ptr() as *mut c_void),
        &mut bi,
        DIB_RGB_COLORS,
    );
    let _ = DeleteDC(hdc);
    cleanup(&ii);
    if lines == 0 {
        return None;
    }
    // BGRA -> RGBA；旧式图标没有 alpha 通道时视为不透明
    let has_alpha = buf.chunks(4).any(|p| p[3] != 0);
    for p in buf.chunks_mut(4) {
        p.swap(0, 2);
        if !has_alpha {
            p[3] = 255;
        }
    }
    Some((w as u32, h as u32, buf))
}

/// 根据扩展名查询默认打开程序，返回友好名称（如 WPS / Word）
pub fn default_app_prog_id(ext: &str) -> Option<String> {
    use winreg::enums::{HKEY_CLASSES_ROOT, HKEY_CURRENT_USER};
    use winreg::RegKey;
    let user_choice = format!(
        "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.{}\\UserChoice",
        ext
    );
    if let Ok(k) = RegKey::predef(HKEY_CURRENT_USER).open_subkey(&user_choice) {
        if let Ok(v) = k.get_value::<String, _>("ProgId") {
            if !v.is_empty() {
                return Some(v);
            }
        }
    }
    if let Ok(k) = RegKey::predef(HKEY_CLASSES_ROOT).open_subkey(format!(".{}", ext)) {
        if let Ok(v) = k.get_value::<String, _>("") {
            if !v.is_empty() {
                return Some(v);
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// OneCommander
// ---------------------------------------------------------------------------

fn env_path(var: &str) -> Option<PathBuf> {
    std::env::var_os(var).map(PathBuf::from)
}

/// 自动查找 OneCommander.exe
pub fn find_one_commander() -> Option<String> {
    let exe = "OneCommander.exe";
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(local) = env_path("LOCALAPPDATA") {
        candidates.push(local.join("Microsoft").join("WindowsApps").join(exe)); // 商店版别名
        candidates.push(local.join("Programs").join("OneCommander").join(exe));
        candidates.push(local.join("OneCommander").join(exe));
    }
    if let Some(home) = env_path("USERPROFILE") {
        candidates.push(home.join("OneCommander").join(exe));
        candidates.push(home.join("Desktop").join("OneCommander").join(exe));
        candidates.push(home.join("Downloads").join("OneCommander").join(exe));
    }
    for pf in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(p) = env_path(pf) {
            candidates.push(p.join("OneCommander").join(exe));
        }
    }
    for d in b'C'..=b'H' {
        let root = PathBuf::from(format!("{}:\\", d as char));
        if !root.exists() {
            continue;
        }
        for sub in ["OneCommander", "Apps\\OneCommander", "Tools\\OneCommander", "Software\\OneCommander",
            "PortableApps\\OneCommander", "Program Files\\OneCommander", "软件\\OneCommander", "绿色软件\\OneCommander"]
        {
            candidates.push(root.join(sub).join(exe));
        }
    }
    if let Some(found) = candidates.into_iter().find(|p| p.is_file()) {
        return Some(found.to_string_lossy().into_owned());
    }

    // PATH 中查找
    if let Ok(out) = Command::new("where.exe").arg(exe).creation_flags(CREATE_NO_WINDOW).output() {
        if out.status.success() {
            if let Some(line) = String::from_utf8_lossy(&out.stdout).lines().next() {
                let p = line.trim();
                if !p.is_empty() && Path::new(p).is_file() {
                    return Some(p.to_string());
                }
            }
        }
    }

    // 正在运行的进程
    if let Ok(out) = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-Process OneCommander -ErrorAction SilentlyContinue | Select-Object -First 1).Path",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    {
        let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !p.is_empty() && Path::new(&p).is_file() {
            return Some(p);
        }
    }
    None
}

pub fn launch(exe: &str, arg: &str) -> std::io::Result<()> {
    Command::new(exe).arg(arg).spawn().map(|_| ())
}
