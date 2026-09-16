# NOTICE — 第三方组件署名

本仓库包含以下 MIT 协议项目的修改版再分发：

## 1. Godot-MCP-Native（含于 gdflow_assets/addons/godot_mcp/ 与 gdflow_assets/gdmcp/）

- 原仓库：https://github.com/yurineko73/Godot-MCP-Native
- 原协议：MIT License © yurineko73
- 本仓库改动（相对上游 v1.0.8）：
  - `addons/godot_mcp/tools/node_tools_native.gd`：属性数组输入转换（Vector2/Color/Rect2）、
    Packed 数组支持（`_convert_packed_array`）、set 后读回验证（verify_failed）
  - `cli/gdmcp`（编译产物 gdflow_assets/gdmcp/gdmcp.exe）：--json 模式参数错误统一 JSON 输出
- 原许可证全文见 gdflow_assets/addons/godot_mcp/LICENSE

## 2. godot-multi-manager（本仓库 manager/ 目录为其完整再分发，含下述改进）

- 原仓库：https://github.com/MBZY/godot-multi-manager
- 原协议：MIT License © MBZY
- 本仓库 manager/ 为完整副本，改动：停止游戏时自动清理孤儿游戏窗口进程
  （lib/gdmcp.mjs + server.mjs）；data/cache/ 内置工具链缓存用于离线部署
- 历史补丁文件仍保留于 patches/manager-orphan-process-cleanup.patch

## 3. Godot Engine

- © Juan Lini, the Godot community — MIT License
- https://godotengine.org
