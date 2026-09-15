# godot-ai-toolkit

给 **AI Agent 操纵 Godot 编辑器** 的实战工具链 + 给**带新人做游戏**的模板包。
所有坑都来自真实项目踩坑（4 个完整小游戏 + 资产域专项测试），每条结论都有验证。

```
AI Agent
  ├─ gdflow.py        单文件零依赖辅助层：init/doctor/run/stop/check/setprop/dump/import
  ├─ gdmcp CLI        原子操作（本仓库自带改进版）：scenes/nodes/scripts/tools/tool-call
  └─ Godot 编辑器      无头实例 + Godot-MCP-Native 插件（本仓库自带补丁版）内开 MCP 服务
        ↑
  godot-multi-manager  多项目/多实例编排（Web UI :17890，独立部署）
```

## 快速开始

前置：装好 Godot 4.x（标准版）、Python 3.8+、[godot-multi-manager](https://github.com/MBZY/godot-multi-manager)（可选，管实例）。

```bash
# 对任意 Godot 项目一键铺设（插件+CLI+埋点单例+配置+注册+自检）
python gdflow.py --project <项目根> init

# 之后
python gdflow.py --project <项目根> doctor   # 环境自检（七项）
python gdflow.py --project <项目根> run      # 跑游戏
python gdflow.py --project <项目根> stop     # 停止+清僵尸进程
```

其余命令：`gdflow.py --help`。AI 客户端使用姿势见 `docs/recipes.md`。

## 本仓库相对上游的改进

| 层 | 改进 | 为什么 |
|---|---|---|
| 插件 | 属性设值**读回验证**（不匹配返回 verify_failed） | 治"返回 success 但值没变"的静默失败 |
| 插件 | JSON 数组 → Vector2/Color/Rect2 自动转换 | 数组格式静默失败的头号来源 |
| 插件 | PackedVector2Array/ColorArray/Float32/Int32/StringArray 支持 | 解锁 Polygon2D 等资产深水区 |
| gdmcp | --json 模式下参数错误输出统一 JSON | Agent 可解析，不再被 clap 纯文本噎住 |
| manager | game/stop 自动清理孤儿游戏进程 | stop 只断会话留僵尸，dump 拿到冻结数据 |
| gdflow | init 一键接入 / doctor 自检 / setprop 智能重试 / import 安全导入 / 自动识别端口 | 把所有踩坑绕行固化成一条命令 |

详细踩坑结论：**[docs/pitfalls.md](docs/pitfalls.md)**（属性区/资产区/权限区/进程区），
AI 组装配方：**[docs/recipes.md](docs/recipes.md)**（手写 tres、直通设值、tile 摆放、音频循环）。

## 带教模板（templates/）

给"零基础新人 + AI 协作做游戏"场景准备的模板：

- `AGENTS.template.md` — AI 项目宪法（复制到项目根，AI 客户端自动读取）
- `GETTING_STARTED.template.md` — 新人一页纸（三条命令 + 提需求姿势）
- `task_cards/` — 任务卡：环境搭建 / 会动的方块（核心代码必须手敲）/ **资产工坊（人机协作分工课）**

带教理念：AI 能干的（格式文件、批量铺量、报错诊断）交给 AI；**判断型劳动**（切帧边界、动画节奏、关卡设计、音效挑选）必须新人自己做——那才是 AI 时代要练的本事。

## 已知边界

- 插件 runtime tilemap 工具只支持老 `TileMap` 节点，不支持 4.3+ 的 `TileMapLayer`（用代码 `set_cell()`）
- 资源内部嵌套数据（动画帧/切片/轨道）无 MCP 工具——手写 `.tres` 或代码构建
- 头less 导入退出时的 leaked/resources-in-use 警告是无害噪音

## 致谢

- [Godot-MCP-Native](https://github.com/yurineko73/Godot-MCP-Native)（MIT）— 编辑器内 MCP 服务器插件，本仓库 `gdflow_assets/addons/` 为其补丁 fork
- [godot-multi-manager](https://github.com/MBZY/godot-multi-manager)（MIT）— 多实例管理器，本仓库 `patches/` 含改进补丁
- gdmcp CLI 源自 Godot-MCP-Native 仓库 `cli/gdmcp`，本仓库二进制为改进版本地编译

改动均为 MIT 协议下的再分发，上游署名见 [NOTICE.md](NOTICE.md)。
