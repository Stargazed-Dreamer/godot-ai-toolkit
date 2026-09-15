# 踩坑手册（AI 操作 Godot 编辑器 · 实测结论）

> 基于 Godot 4.6.3 + Godot-MCP-Native v1.0.8（含本仓库补丁）+ gdmcp CLI 的四轮游戏实战 + 资产域专项踩坑。
> 每条都经过真实项目验证，不是文档推断。

## 0. 三层工具链与分工

```
AI Agent
  ├─ gdflow.py      首选入口：init/doctor/run/stop/check/setprop/dump/import（本仓库）
  ├─ gdmcp CLI      原子操作：scenes/nodes/tools/tool-call（本仓库自带补丁版）
  └─ Godot 编辑器    无头实例跑在 godot-multi-manager 里，插件内开 MCP 服务
```

**原则：能用 gdflow 就不要手搓 gdmcp 调用**——gdflow 封装了下面所有坑的绕行逻辑。

## 1. 属性设置（静默失败区）

| 属性类型 | 怎么设 | 状态 |
|---|---|---|
| 数字/字符串 | 直接 `nodes properties set` | ✅ |
| Vector2/Color | **对象格式** `{"x":1,"y":2}`；JSON 数组 `[1,2]` 会静默失败 | ✅ gdflow setprop 自动重试+读回 |
| **资源引用**（texture/tile_set/sprite_frames/stream/script） | **字符串路径直通** `"res://assets/a.png"`，插件自动 load | ✅ 实测全通 |
| PackedVector2Array 等 | 对象数组 `[{"x":..,"y":..}]` 或扁平数组（本仓库补丁解锁） | ✅ |
| **资源内部嵌套数据**（SpriteFrames 帧、Animation 轨道、TileSet 切片） | **无 MCP 工具，别试** → 用手写 .tres 或代码构建（见 recipes） | ❌ 边界 |
| AnimationLibrary 存 tres | **陷阱**：ResourceSaver 保存时动画数据不落盘（_data 为空），手写 _data 格式 load 后 has_animation 也为 false → 动画正解是**手写场景 tscn 内嵌 sub_resource**（recipes 配方 7） | ⚠️ 实测 |

插件已带读回验证补丁：set 后自动比较，不匹配返回 `verify_failed`——看到 success 不代表真的写进去了，**以读回为准**。

## 2. 资产域结论（4.x）

| 事项 | 结论 |
|---|---|
| 批量导入 | `godot --headless --path <项目> --import` 一次导入全部；**先停编辑器实例**（gdflow import 自动处理），否则与实例导入态互相踩 |
| 退出警告 | headless 导入退出时的 `ObjectDB instances leaked` / `resources still in use` 是**无害噪音**，不要当错误修 |
| SpriteFrames | create_resource + 属性直通挂载 ✅；帧序列**手写 .tres**（AtlasTexture region 随意切，load 直读无需 import）✅ |
| TileSet | .tres 手写图块声明 `0:0/0 = 0`（x:y/备用 = 0）✅；tile_set 属性直通挂载 ✅ |
| TileMap runtime 摆格子 | 插件工具**只支持老 TileMap 节点，不支持 TileMapLayer**（4.3+ 推荐节点）；TileMapLayer 用代码 `set_cell()` |
| 音频循环 | 改 `.import` 的 `edit/loop_mode` 后重导入。**枚举：0=Detect / 1=Disabled / 2=Forward / 3=PingPong / 4=Backward**（和 AudioStreamWAV.loop_mode 的 0=Disabled/1=Forward 是两套表，别混！） |
| reimport | MCP `reimport_resources` 可用；但手改 .import 后建议走 `gdflow import` 全量更稳 |

## 3. 权限与管控（Vibe Coding 模式）

| 操作 | 要求 |
|---|---|
| run_project / stop_project | args 里加 `"allow_window": true` |
| open_scene | args 里加 `"allow_ui_focus": true` |
| runtime 写类工具（set_tilemap_cell 等） | CLI 加 `--allow-open-world`（**放在 tool-call 子命令之后**），MCP 协议通道自动放行 |
| 普通属性/节点读写 | 无要求 |

## 4. 实例与进程

- **改 project.godot 前必须停实例**（projstop → 改 → projstart），编辑器退出时会回写覆盖你的手改（本项目踩过 3 次）
- stop_project 只断调试会话**不杀游戏进程**——僵尸窗口会让后续 dump 返回冻结数据；gdflow stop 已自动清理
- 多个 headless 实例抢同一项目 → 游戏秒退；projstart 内置防重
- manager 必须用分离进程方式跑（终端会话被回收会带走 manager）

## 5. GDScript 编译器

- `var x := <Variant 源>` 会 Parse Error——凡 Variant 源赋值必须显式类型（`var sc: float = ...`）
- Typed Array 严格匹配：const 字典取出的数组传给 `Array[Vector2i]` 参数报 Invalid type——逐元素显式转换
- gdmcp `validate` 信息笼统时，用 `gdflow validate`（自动升级主循环拿真实行号）

## 6. 调试方法论（数据埋点优先）

1. **在代码里埋点，不要靠看画面**：DebugRing 内存环形缓冲（上限 500 条），`gdflow dump` 拉取，零磁盘写入
2. **进程级故障才看屏幕**（卡 splash/窗口没出）：两层观察分工
3. `get_editor_logs` 三个 source：`mcp`=工具日志、`editor_panel`=编辑器输出（游戏 print **不进**这里）、`runtime`=godot.log（无头默认空）
4. 截图同会话只第一张新鲜——用 `gdflow shot` 走外部截图

## 7. 实战新坑（platformer-test 整游戏验证，2026-09-16）

| 坑 | 现象 | 对策 |
|---|---|---|
| **物理回调里切场景** ⭐ | `body_entered`/`_physics_process` 中直接 `change_scene_to_file`/`reload_current_scene` → **整个游戏进程挂死**（帧数冻结、无报错） | 一律 `.call_deferred()`（实测挂死复现 2 次后修复） |
| runtime set 位置格式 | `"(x,y)"` 文本格式静默失败（放节点到 0,0）；返回 ok 但没生效 | 用 JSON 对象 `{"x":..,"y":..}`，**改后必读回** |
| `--headless --script` 模式 | 引用 autoload 名（GameState/Sfx）的脚本**编译失败**（该模式不初始化 autoload） | 诊断脚本别碰 autoload；权威验证用 `gdflow check`（标准主循环） |
| Git Bash 路径转换 | `/root/Node` 参数被 MSYS 转成本地盘路径 → "Node not found: E:/.../root/..." | 前缀 `export MSYS2_ARG_CONV_EXCL="*"` |
| 受伤无无敌帧 | 重叠期 body_entered 重复触发连扣多命 | 受伤冷却计时器（0.9s） |
| API 假设 | DebugRing 的方法是 `dbg()` 不是 `log()`——用工具前先 grep 实际 API | `grep -n "^func" xxx.gd` |
