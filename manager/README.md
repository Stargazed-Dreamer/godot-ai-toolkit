<div align="center">

# Godot Multi-Manager

**A multi-project / multi-instance manager built on the [Godot-MCP-Native](https://github.com/yurineko73/Godot-MCP-Native) plugin and the gdmcp CLI**

Local web service + browser UI · Zero npm dependencies · Up and running with one command

*一个用于并行运行多个 Godot 编辑器 / 无头引擎 / 游戏实例的本地 Web 管理器 —— 每个实例都绑定到自己的 Godot-MCP-Native 服务端与项目级 gdmcp CLI。*

[中文](README.zh-CN.md) | **English**

![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=nodedotjs&logoColor=white)
![Godot](https://img.shields.io/badge/Godot-4.6%2B-478CBF?logo=godotengine&logoColor=white)
![Dependencies](https://img.shields.io/badge/dependencies-0-green)
![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)
![License](https://img.shields.io/badge/license-MIT-blue)

<!-- Suggested: add a UI screenshot at docs/screenshot.png -->

```
┌─────────────┬──────────────────────────────────────────────┐
│ Projects    │  MyGame             [MCP :19080] [Plugin✓][CLI✓] │
│             │  ▶ Launch Editor  ⬛ Launch Headless  🎮 Run Game  ⏹ Stop All │
│ ● MyGame    │  ──────────────────────────────────────────   │
│   :19080    │  [Headless :19080 PID 12345] [To Editor] [Stop] │
│ ○ DemoGame  │  ──────────────────────────────────────────   │
│   :19081    │  [Terminal] [Debug] [Overview]                │
│             │  $ godot --headless --editor --path ...       │
│ New Project │  $ [Godot MCP] HTTP server listening :19080   │
└─────────────┴──────────────────────────────────────────────┘
```

</div>

---

## Why this exists

[Godot-MCP-Native](https://github.com/yurineko73/Godot-MCP-Native) lets AI tools drive the Godot editor directly over MCP, and the gdmcp CLI is its command-line companion. But the moment you **develop several projects at once**, or want an **editor and a headless engine running side by side**, a pile of tedious problems shows up: every instance needs its own port, config files must line up one by one, the CLI has to connect to the *right* instance, processes need managing, logs need watching…

This manager bundles all of that into one-click operations: **create and it's configured, launch and it's wired up, stop and it's clean.**

## ✨ Features

| Feature | Description |
| --- | --- |
| 🖥 Live terminal | A dedicated terminal page per instance: real-time stdout/stderr streaming (SSE), log-level colouring, auto-scroll / copy / clear, and a one-click stop button in the toolbar |
| ⬛ One-click headless engine | `godot --headless --editor --path <project> -- --mcp-server --mcp-port=<port>`; stopping goes through `taskkill /T` to kill the whole process tree — no leftovers |
| 📦 One-click project creation | New-project wizard: generate `project.godot` / main scene / icon → install plugin → enable plugin → install gdmcp CLI → write port → first asset import. Fully automatic |
| 🔧 One-click setup of existing projects | After adding a project, hit "Configure MCP environment" to run the same install flow; it detects and replaces the older DaxianLee plugin |
| 🔢 Port management | A fixed port per project (auto-assigned from 19080, manually editable), written to `user://mcp_settings.cfg` **and** passed at launch via `--mcp-port` as a belt-and-braces measure; OS-level conflict detection falls back to a temporary port if taken |
| 🎮 One-click game run | ① Plain run (a standalone game process — multiple clients can be launched) ② Debug run (spawned by the MCP instance's `run_project`, with a debug session attached) |
| 🔄 Editor ⇄ Headless switching | Toggle an instance's run mode from its card in one click; the port stays the same |
| 🐛 Debug info | gdmcp doctor diagnosis / editor state / editor logs / runtime scene tree, with 2 / 5 / 10-second auto-refresh |
| 🎨 Lightweight modern UI | A native HTML/CSS/JS single-page app, dark theme, no build step, no framework, no dependencies |

## 🚀 Quick start

### Prerequisites

- **Node.js ≥ 18** ([download](https://nodejs.org/))
- **Godot 4.6+** (the Steam build works out of the box — the manager detects Steam library installs automatically)
- **Windows** (relies on the bundled `tar` (bsdtar) and `taskkill`)

### Install and run

```bash
git clone https://github.com/MBZY/godot-multi-manager.git
cd godot-multi-manager
npm start          # or: node server.mjs
```

Open **http://127.0.0.1:17890** and you're good to go.

> On first launch the toolchain is downloaded from a GitHub Release (the Godot-MCP-Native plugin zip + the gdmcp CLI zip, ~2 MB) and cached in `data/cache/` for later offline reuse. If the download fails, see [Troubleshooting](#-troubleshooting).

### Up and running in three minutes

1. **New project** (top-left): enter a name, pick a directory → the MCP environment is configured automatically. Or **add an existing project** and click "🔧 Configure MCP environment".
2. **Launch**: `▶ Launch Editor` / `⬛ Launch Headless` / `🎮 Run Game` — several can run at once.
3. **Watch logs**: the "Terminal" tab shows each instance's output in real time.
4. **Debug**: the "Debug" tab → doctor diagnosis / editor state / debug logs / runtime scene tree (pair it with "▶ Debug Run" to inspect live game data).
5. **Stop**: stop instances one by one from their cards, or hit "⏹ Stop All". An editor instance can also be switched to headless in one click (and back).

## 🔌 The one-to-one port mapping (core design)

Each project gets a fixed MCP port, with three layers of guarantees that it stays in sync with the gdmcp CLI:

1. Write `http_port` into `%APPDATA%\Godot\app_userdata\<project>\mcp_settings.cfg` — the basis for gdmcp's official auto-discovery;
2. Pass `-- --mcp-server --mcp-port=<port>` explicitly on every launch — the official multi-instance approach, overriding via command line;
3. When the manager invokes gdmcp it always passes `--url http://127.0.0.1:<port>` explicitly, so other MCP instances on the machine (say, the default 9080) can't interfere.

Launching a second editor/headless instance for the same project automatically assigns a temporary port (including OS-level occupancy detection, so orphaned Godot processes left over from a server restart are avoided too). Extra game clients don't consume ports. Repeated clicks of the same mode for the same project within 1.5 seconds are ignored (double-click protection).

## 🎮 The three instance modes

| Mode | Launch command | Purpose |
| --- | --- | --- |
| Editor | `godot --editor --path <p> -- --mcp-server --mcp-port=N` | Visual editing + MCP |
| Headless engine | `godot --headless --editor --path <p> -- --mcp-server --mcp-port=N` | Background MCP instance (AI orchestration, CI) |
| Game | `godot --path <p>` | Playing directly / running multiple networked clients |

Debug Run (a button in the Debug panel) launches the game from the editor instance via the MCP `run_project` tool. It comes with an EngineDebugger session, which makes the runtime scene tree and runtime node reads available.

## 🛠 Troubleshooting

| Symptom | Fix |
| --- | --- |
| Toolchain download fails | Configure an HTTP proxy in Settings and click the toolchain badge in the top-right to retry; or manually download `godot-mcp-native-*.zip` and `gdmcp-*-x86_64-pc-windows-msvc.zip` from the [Releases](https://github.com/yurineko73/Godot-MCP-Native/releases) page into `data/cache/` |
| Godot not detected | Settings → Godot executable → enter the full path to `godot.windows.opt.tools.64.exe`, or click "Detect" |
| The web UI won't open | If port 17890 is taken, change `settings.webPort` in `data/config.json` and restart |
| An AI client can't reach MCP | Make sure the project has an editor or headless instance running (game processes don't serve MCP); the endpoint is `http://127.0.0.1:<project port>/mcp` |
| gdmcp doctor connects to the wrong project | Internally the manager always passes `--url`, so it's unaffected. When using gdmcp manually in a terminal, run it from the project root or pass `--url` |

## 📁 Project structure

```
├── server.mjs            # Entry point: HTTP API + static files + SSE
├── lib/
│   ├── config.mjs        # Config persistence + Godot path detection (Steam library scan)
│   ├── ports.mjs         # Port allocation + TCP availability probing
│   ├── instances.mjs     # Instance lifecycle: spawn / taskkill tree kill / stdout line capture / mode switching
│   ├── projects.mjs      # Register / create / one-click configure / enable plugin in project.godot / write mcp_settings.cfg
│   ├── toolchain.mjs     # GitHub Release download (curl, with proxy and direct fallbacks) + bsdtar extraction
│   ├── gdmcp.mjs         # gdmcp CLI wrapper (doctor / editor state / debug logs / runtime tree / run·stop)
│   ├── logs.mjs          # Ring-buffer logs + persistence to disk
│   └── bus.mjs           # Event bus → SSE broadcast
├── public/               # Front-end SPA (index.html / app.js / style.css)
├── scripts/ui-smoke.mjs  # Front-end regression smoke test (real tree-structure DOM stub + real server)
└── data/                 # Runtime data (git-ignored): config.json / cache / logs
```

## 🔗 HTTP API

The manager is also a local API service you can use for scripted orchestration:

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/state` | Full state (settings + toolchain + projects + instances) |
| GET/POST | `/api/settings` | Read / update settings (Godot path, port base, proxy) |
| POST | `/api/toolchain/download` | Download / extract the toolchain |
| POST | `/api/projects` | Add an existing project |
| POST | `/api/projects/create` | Create a new project (configuring the MCP environment automatically) |
| DELETE | `/api/projects/:id` | Remove a project (stops its instances, leaves files untouched) |
| POST | `/api/projects/:id/configure` | One-click MCP environment setup |
| PUT | `/api/projects/:id/port` | Change the port |
| POST | `/api/instances` | Launch an instance (editor / headless / game) |
| DELETE | `/api/instances/:id` | Stop an instance |
| POST | `/api/instances/:id/switch` | Switch editor ⇄ headless |
| GET | `/api/instances/:id/logs` | Terminal history |
| GET | `/api/projects/:id/debug?kind=doctor\|editor_state\|logs\|runtime_tree` | gdmcp debug info |
| POST | `/api/projects/:id/game/run\|stop` | Debug run / stop the game (with a debug session) |
| GET | `/api/events` | SSE: `state` events + `log` stream |

## 🔬 Technical notes

- `mcp_settings.cfg` uses Godot's ConfigFile format (`[meta] version` + `[settings] http_port`, etc.). Its md5 checksum key can be **omitted and the config is still accepted**, which is how the manager generates a valid config directly.
- The `-- --mcp-server` arguments must come after `--` (Godot user arguments); the plugin uses them to start the MCP server automatically in headless mode.
- `run_project` / `stop_project` need `allow_window=true` to bypass the plugin's Vibe Coding window guard.
- The toolchain version is pinned to `v1.0.8` (a constant at the top of `lib/toolchain.mjs` can be bumped).
- When the manager exits (process tree terminated) it also stops the instances it launched; instance logs are persisted to `data/logs/`.

## 🧪 Testing

```bash
npm run smoke    # Requires the server to be running; 28 assertions covering every front-end render path and real interactions
```

The smoke test uses a **real tree-structure DOM stub** (querySelector walks the tree, attributes are stored independently), so it catches genuine browser bugs like "a global query before the element is mounted returns null" and "boolean attributes set incorrectly". Interaction assertions (launch debouncing, the Stop All confirmation dialog, SSE state sync) hit the real server directly.

Development was verified end to end on Windows + Godot 4.7.1 (Steam): create project → headless launch → MCP handshake → gdmcp doctor pointing at the right project → debug run → runtime scene tree → mode switching → two instances of the same project (temporary port) → Stop All leaving no leftovers.

## 🗺 Roadmap

- [ ] macOS / Linux support (abstracting process management and path detection)
- [ ] Re-adopt running instances after a server restart (process scan adoption)
- [ ] Online toolchain version upgrades
- [ ] MCP auth token support (`GODOT_MCP_TOKEN`)
- [ ] Terminal search / filtering

## ⚠️ Known limitations

- Windows only (`taskkill`, bsdtar, `%APPDATA%` paths).
- A second editor/headless instance for the same project uses a temporary port; gdmcp and the Debug panel always point at the project's primary port.

## 🤝 Credits

- [Godot-MCP-Native](https://github.com/yurineko73/Godot-MCP-Native) and its gdmcp CLI — the core dependencies of this project
- [Godot Engine](https://godotengine.org/)

Issues and PRs welcome ⭐

## 📄 License

[MIT](LICENSE)
