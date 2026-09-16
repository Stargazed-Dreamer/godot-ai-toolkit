<div align="center">

# Godot 多开管理器

**基于 [Godot-MCP-Native](https://github.com/yurineko73/Godot-MCP-Native) 插件与 gdmcp CLI 的多项目 / 多实例管理器**

本地 Web 服务 + 浏览器界面 · 零 npm 依赖 · 一个命令跑起来

*A local web-based manager for running multiple Godot editor / headless / game instances in parallel — each wired to its own Godot-MCP-Native server and project-local gdmcp CLI.*

**中文** | [English](README.md)

![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=nodedotjs&logoColor=white)
![Godot](https://img.shields.io/badge/Godot-4.6%2B-478CBF?logo=godotengine&logoColor=white)
![Dependencies](https://img.shields.io/badge/dependencies-0-green)
![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)
![License](https://img.shields.io/badge/license-MIT-blue)

<!-- 建议补充一张界面截图：docs/screenshot.png -->

```
┌─────────────┬──────────────────────────────────────────────┐
│ 项目列表     │  MyGame              [MCP :19080] [插件✓][CLI✓]  │
│             │  ▶启动编辑器  ⬛启动无头  🎮运行游戏  ⏹全部停止     │
│ ● MyGame    │  ──────────────────────────────────────────   │
│   :19080    │  [无头引擎 :19080 PID 12345] [切编辑器] [停止]     │
│ ○ DemoGame  │  ──────────────────────────────────────────   │
│   :19081    │  [终端] [调试] [概览]                            │
│             │  $ godot --headless --editor --path ...        │
│ ＋新建项目   │  $ [Godot MCP] HTTP server listening :19080    │
└─────────────┴──────────────────────────────────────────────┘
```

</div>

---

## 为什么需要它

[Godot-MCP-Native](https://github.com/yurineko73/Godot-MCP-Native) 让 AI 工具通过 MCP 直接操作 Godot 编辑器，而 gdmcp CLI 则是它的命令行搭档。但当你**同时开发多个项目**、或想让**编辑器与无头引擎并存**时，会遇到一堆琐碎问题：每个实例要分配独立端口、配置文件要一一对应、CLI 要连到正确的实例、进程要管理、日志要看……

这个管理器把这些全部打包成一键操作：**创建即配置、启动即对应、停止即干净**。

## ✨ 功能特性

| 功能 | 说明 |
| --- | --- |
| 🖥 实时终端 | 每个实例独立终端页：stdout/stderr 实时滚动（SSE 推流）、按日志等级着色、自动滚动 / 复制 / 清屏，工具栏可一键停止当前实例 |
| ⬛ 无头引擎一键启停 | `godot --headless --editor --path <项目> -- --mcp-server --mcp-port=<端口>`，停止走 `taskkill /T` 进程树清理，无残留 |
| 📦 一键创建项目 | 新建向导：生成 project.godot / 主场景 / 图标 → 装插件 → 启用插件 → 装 gdmcp CLI → 写端口 → 首次资源导入，全自动 |
| 🔧 一键配置已有项目 | 添加项目后点「一键配置 MCP 环境」执行同样的安装流程；能识别并替换旧版 DaxianLee 插件 |
| 🔢 端口管理 | 每项目固定端口（默认从 19080 自动分配，可手改），写入 `user://mcp_settings.cfg` 并在启动时用 `--mcp-port` 双保险；OS 级冲突检测，被占时自动改用临时端口 |
| 🎮 一键运行游戏 | ① 直接运行（独立游戏进程，可多开客户端）② 调试运行（由 MCP 实例 `run_project` 拉起，带调试会话） |
| 🔄 编辑器 ⇄ 无头切换 | 实例卡片一键切换运行模式，端口保持不变 |
| 🐛 调试信息 | gdmcp doctor 诊断 / 编辑器状态 / 编辑器日志 / 运行时场景树，支持 2/5/10 秒自动刷新 |
| 🎨 轻量现代 UI | 原生 HTML/CSS/JS 单页应用，深色主题，无构建、无框架、无依赖 |

## 🚀 快速开始

### 前置要求

- **Node.js ≥ 18**（[下载](https://nodejs.org/)）
- **Godot 4.6+**（Steam 版可直接使用，管理器会自动探测 Steam 库安装）
- **Windows**（依赖系统自带 `tar`（bsdtar）与 `taskkill`）

### 安装与运行

```bash
git clone https://github.com/MBZY/godot-multi-manager.git
cd godot-multi-manager
npm start          # 或 node server.mjs
```

打开 **http://127.0.0.1:17890** 即可使用。

> 首次启动会自动从 GitHub Release 下载工具链（Godot-MCP-Native 插件 zip + gdmcp CLI zip，约 2 MB）并缓存到 `data/cache/`，之后离线复用。下载失败见下方[故障排查](#-故障排查)。

### 三分钟上手

1. **新建项目**（左上角）：填名称、选目录 → 自动完成 MCP 环境配置；或**添加已有项目**后点「🔧 一键配置 MCP 环境」
2. **启动**：`▶ 启动编辑器` / `⬛ 启动无头引擎` / `🎮 运行游戏`，可同时开多个
3. **看日志**：「终端」标签页实时显示每个实例的输出
4. **调试**：「调试」标签页 → Doctor 诊断 / 编辑器状态 / 调试日志 / 运行时场景树（配合「▶ 调试运行」可看游戏运行时数据）
5. **停止**：实例卡片逐个停，或「⏹ 全部停止」；编辑器实例可一键切无头（或反向）

## 🔌 端口一一对应机制（核心设计）

每个项目分配一个固定 MCP 端口，三层保障与 gdmcp CLI 一一对应：

1. 写入 `%APPDATA%\Godot\app_userdata\<项目名>\mcp_settings.cfg` 的 `http_port`（gdmcp 的官方自动发现依据）；
2. 每次启动显式传 `-- --mcp-server --mcp-port=<端口>`（命令行覆盖，官方多开方式）；
3. 管理器调用 gdmcp 时显式传 `--url http://127.0.0.1:<端口>`，避免本机其他 MCP 实例（如默认 9080）干扰。

同项目启动第二个编辑器/无头实例时自动分配临时端口（含 OS 级占用检测，服务器重启遗留的孤儿 Godot 进程也能正确规避）；游戏多开客户端不占端口。同项目同模式 1.5 秒内的重复点击会被忽略（防手滑双击）。

## 🎮 实例三种模式

| 模式 | 启动命令 | 用途 |
| --- | --- | --- |
| 编辑器 | `godot --editor --path <p> -- --mcp-server --mcp-port=N` | 可视化编辑 + MCP |
| 无头引擎 | `godot --headless --editor --path <p> -- --mcp-server --mcp-port=N` | 后台 MCP 实例（AI 编排、CI） |
| 游戏 | `godot --path <p>` | 直接游玩 / 联机多开 |

调试运行（调试面板内按钮）通过 MCP `run_project` 工具由编辑器实例拉起游戏，自带 EngineDebugger 会话，运行时场景树 / 运行时节点读取可用。

## 🛠 故障排查

| 症状 | 解决 |
| --- | --- |
| 工具链下载失败 | 设置里配置 HTTP 代理后点右上角工具链徽章重试；或手动下载 [Release](https://github.com/yurineko73/Godot-MCP-Native/releases) 中的 `godot-mcp-native-*.zip` 与 `gdmcp-*-x86_64-pc-windows-msvc.zip` 放入 `data/cache/` |
| 未检测到 Godot | 设置 → Godot 可执行文件 → 填写 `godot.windows.opt.tools.64.exe` 完整路径，或点「检测」 |
| Web 界面打不开 | 端口 17890 被占用时，修改 `data/config.json` 的 `settings.webPort` 后重启 |
| AI 客户端连不上 MCP | 确认该项目有编辑器或无头实例在运行（游戏进程不提供 MCP）；端点为 `http://127.0.0.1:<项目端口>/mcp` |
| gdmcp doctor 连到别的项目 | 管理器内部调用始终显式传 `--url` 不受影响；手动在终端用 gdmcp 时请在对应项目根目录运行，或加 `--url` |

## 📁 项目结构

```
├── server.mjs            # 入口：HTTP API + 静态文件 + SSE
├── lib/
│   ├── config.mjs        # 配置持久化 + Godot 路径探测（Steam 库扫描）
│   ├── ports.mjs         # 端口分配 + TCP 空闲探测
│   ├── instances.mjs     # 实例生命周期：spawn / taskkill 树杀 / stdout 分行采集 / 模式切换
│   ├── projects.mjs      # 注册 / 新建 / 一键配置 / project.godot 插件启用 / mcp_settings.cfg 写入
│   ├── toolchain.mjs     # GitHub Release 下载（curl，支持代理与直连回退）+ bsdtar 解压
│   ├── gdmcp.mjs         # gdmcp CLI 封装（doctor / editor state / debug logs / runtime tree / run·stop）
│   ├── logs.mjs          # 日志环形缓冲 + 落盘
│   └── bus.mjs           # 事件总线 → SSE 广播
├── public/               # 前端 SPA（index.html / app.js / style.css）
├── scripts/ui-smoke.mjs  # 前端回归冒烟测试（真实树结构 DOM 桩 + 真实服务端）
└── data/                 # 运行时数据（git 忽略）：config.json / cache / logs
```

## 🔗 HTTP API

管理器同时是一个本地 API 服务，可用于脚本化编排：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 全量状态（设置 + 工具链 + 项目 + 实例） |
| GET/POST | `/api/settings` | 读取 / 更新设置（Godot 路径、端口基址、代理） |
| POST | `/api/toolchain/download` | 下载 / 解压工具链 |
| POST | `/api/projects` | 添加已有项目 |
| POST | `/api/projects/create` | 新建项目（自动配置 MCP 环境） |
| DELETE | `/api/projects/:id` | 移除项目（停止其实例，不动文件） |
| POST | `/api/projects/:id/configure` | 一键配置 MCP 环境 |
| PUT | `/api/projects/:id/port` | 修改端口 |
| POST | `/api/instances` | 启动实例（editor / headless / game） |
| DELETE | `/api/instances/:id` | 停止实例 |
| POST | `/api/instances/:id/switch` | 编辑器 ⇄ 无头切换 |
| GET | `/api/instances/:id/logs` | 终端历史 |
| GET | `/api/projects/:id/debug?kind=doctor\|editor_state\|logs\|runtime_tree` | gdmcp 调试信息 |
| POST | `/api/projects/:id/game/run\|stop` | 调试运行 / 停止游戏（带调试会话） |
| GET | `/api/events` | SSE：state 状态事件 + log 日志流 |

## 🔬 技术细节备忘

- `mcp_settings.cfg` 为 Godot ConfigFile 格式（`[meta] version` + `[settings] http_port` 等）；其 md5 校验和键**省略时配置仍被接受**，管理器借此直接生成合法配置。
- `-- --mcp-server` 参数必须放在 `--` 之后（Godot 用户参数），插件据此在无头模式下自动启动 MCP 服务。
- `run_project` / `stop_project` 需传 `allow_window=true` 绕过插件的 Vibe Coding 窗口管控。
- 工具链固定版本 `v1.0.8`（`lib/toolchain.mjs` 顶部常量可升级）。
- 管理器退出（进程树终止）会一并停止它启动的实例；实例日志同时落盘在 `data/logs/`。

## 🧪 测试

```bash
npm run smoke    # 需先启动服务；28 项断言覆盖前端全部渲染路径与真实交互
```

冒烟测试使用**真实树结构的 DOM 桩**（querySelector 走树、属性独立存储），能捕获「元素挂载前全局查询返回 null」「布尔属性误设置」等真实浏览器 bug；交互断言（启动防抖、全部停止确认框、SSE 状态同步）直接打到真实服务端。

开发过程中已在 Windows + Godot 4.7.1（Steam）环境完成端到端验证：新建项目 → 无头启动 → MCP 握手 → gdmcp doctor 指向正确项目 → 调试运行 → 运行时场景树 → 模式切换 → 同项目双开（临时端口）→ 全部停止无残留。

## 🗺 路线图

- [ ] macOS / Linux 支持（进程管理与路径探测抽象化）
- [ ] 服务器重启后重新接管运行中的实例（进程扫描收养）
- [ ] 工具链版本在线升级
- [ ] MCP auth token 支持（`GODOT_MCP_TOKEN`）
- [ ] 终端搜索 / 过滤

## ⚠️ 已知限制

- 仅适配 Windows（`taskkill`、bsdtar、`%APPDATA%` 路径）。
- 同项目的第二个编辑器/无头实例使用临时端口，gdmcp 与调试面板始终指向项目主端口。

## 🤝 致谢

- [Godot-MCP-Native](https://github.com/yurineko73/Godot-MCP-Native) 及其 gdmcp CLI —— 本项目的核心依赖
- [Godot Engine](https://godotengine.org/)

欢迎 Issue 与 PR ⭐。

## 📄 许可证

[MIT](LICENSE)
