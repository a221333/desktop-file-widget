# 桌面文件小组件

Windows 桌面小组件（Tauri 2），复刻“最近打开的文件 + 常用文件与文件夹”卡片。体积仅几 MB（使用系统自带 WebView2）。

## 两个版本

| 版本 | 区别 |
|---|---|
| 普通版 | 文件夹、定位文件 使用系统资源管理器 |
| OneCommander 特供版 | 文件夹、定位文件 使用 **OneCommander** 打开（文件仍用默认程序打开）。自动查找 OneCommander.exe，找不到时提示手动选择；「⋯」菜单可修改路径或临时关闭。右键菜单保留「用资源管理器打开」。 |

两个版本配置互相独立，可同时安装。

## 功能

- **最近打开的文件**：读取系统最近列表（`%APPDATA%\Microsoft\Windows\Recent`），显示系统图标、默认打开程序（WPS / Word / Excel…）和时间，目录变化时自动刷新。
  - 双击打开；右键：收藏置顶 / 取消收藏 / 定位文件 / 添加到常用 / 复制路径 / 从列表中移除
  - 拖动最近文件到「常用」卡片即可收藏
- **常用文件与文件夹**：「添加」按钮或从资源管理器拖入；拖拽排序；右键重命名、定位、移除；失效路径灰显。
- **窗口**：无边框半透明、拖动标题栏移动、可调大小、记住位置；不占任务栏，常驻托盘。
- **「⋯」菜单**：背景不透明度、始终置顶、开机自启、最近列表包含文件夹、恢复已移除项、重置位置、退出。

配置文件：`%APPDATA%\com.a221333.desktopfilewidget\config.json`（特供版为 `…desktopfilewidget.oc`）。

## 开发

需要 Node.js 与 Rust。

```bash
npm install
npm run dev          # 开发运行
npm run build        # 普通版
npm run build:oc     # OneCommander 特供版
```

推送 `v*` 标签后，GitHub Actions 会自动构建两个版本并发布到 Release。
