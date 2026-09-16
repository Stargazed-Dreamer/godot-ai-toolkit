# DEPLOY.md — 部署指令（给 AI 助手读）

> 新人只需要对本机 AI 助手说："克隆 https://github.com/Stargazed-Dreamer/godot-ai-toolkit 并按仓库里的 DEPLOY.md 帮我部署"。
> AI 按本文执行。每步末尾是验收标准，全过即部署完成。

## 目标终态

1. Godot 4.x 标准版可用
2. 本仓库已克隆到本地（下称 `<toolkit>`）
3. manager 已启动（Web UI http://127.0.0.1:17890）
4. 一个 Godot 项目已通过 `gdflow init` 接入，`gdflow doctor` 七项全 OK

## 步骤

### 0. 前置探测（缺什么装什么）

| 依赖 | 检测 | 缺失时 |
|---|---|---|
| Python 3.8+ | `python --version` | https://www.python.org/downloads/ 安装，**必须勾选 Add to PATH** |
| Node.js 18+ | `node -v` | https://nodejs.org/ 装 LTS 版，默认选项一路下一步 |
| Git | `git --version` | https://git-scm.com/ 或让 AI 用客户端自带工具 |
| Godot 4.x 标准版 | 探测常见安装路径 / 问用户 | https://godotengine.org/download 下 **Godot Engine**（**不是 .NET 版**），解压即用；记住 godot.windows.opt.tools.64.exe 的完整路径 |

### 1. 克隆仓库

```
git clone https://github.com/Stargazed-Dreamer/godot-ai-toolkit
```

网络失败可重试，或用镜像前缀 `https://ghproxy.net/https://github.com/...`。
（已在本仓库目录内则跳过。）

### 2. 启动 manager

Windows：双击 `start_manager.bat`，或命令行：

```
cd <toolkit>/manager
node server.mjs
```

- 首次启动自动生成 `manager/data/config.json`，无需手动配置
- **离线可用**：`manager/data/cache/` 已内置工具链缓存，不访问 GitHub
- 验收：浏览器打开 http://127.0.0.1:17890 能看到 Web UI
- 注意：这个终端窗口要保持开着（关掉 = 管理器下线）

### 3. 创建/准备一个 Godot 项目

没有项目就新建：任意目录建空文件夹 + `project.godot`（最小内容见 README「新建项目」节），或用 Godot 编辑器图形化新建。

### 4. init 一键接入

```
python gdflow.py --project <项目绝对路径> init --godot <Godot.exe 绝对路径>
```

- Windows 路径含空格必须加引号
- 首次接入的导入环节需要 30–60 秒，属正常
- manager 未启动时 init 仍会完成大部分（会提示跳过注册）——**必须先做步骤 2**

### 5. 验收

```
python gdflow.py --project <项目绝对路径> doctor
```

七项全部 `[OK]` 即部署完成。任何 FAIL 项按下表处理：

| FAIL 项 | 处理 |
|---|---|
| Godot 引擎 | 路径不对 → `--godot` 指定或设环境变量 GODOT_PATH |
| gdmcp CLI | 在 `<toolkit>` 根目录运行（gdflow 靠相对位置找工具链源） |
| MCP 实例 | manager 在跑吗 → 重做步骤 2，然后 `gdflow projstart` |
| 管理器注册 | manager 没起或项目没注册 → 重跑 `gdflow init` |
| Godot 用户目录 | 打开一次 Godot 编辑器再跑 doctor |

## 常见坑速查

- Python 装了但命令找不到 → 重装勾选 Add to PATH；微软商店版有坑，用 python.org 官方安装器
- 17890 端口被占 → 关掉旧的 manager 窗口；实在不行改 `manager/data/config.json` 的 webPort
- Godot 下载到 .NET 版 → 重新下标准版（图标是机器人头，文件名不带 _mono/_dotnet）
