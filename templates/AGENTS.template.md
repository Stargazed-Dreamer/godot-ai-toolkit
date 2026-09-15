# AGENTS.md 模板（复制到你的 Godot 项目根目录，替换尖括号部分）

> 给 AI Agent 的项目宪法。AI 客户端（ZCode/Trae/Cursor/Claude Code 等）打开本项目时会自动读取。

## 项目信息

- Godot 版本：<4.6>
- 主场景：<res://scenes/main.tscn>
- MCP 端口：<自动——不要写死，用 gdflow 自动识别>

## 工具链使用规则（重要）

1. **一切操作优先走 `gdflow.py`**（单文件零依赖）：
   - 环境自检：`python gdflow.py --project <项目根> doctor`
   - 跑游戏/停：`run` / `stop`；权威验证：`check`；脚本检查：`validate res://...`
   - 属性设置：`setprop`（自动处理格式坑+读回验证）
   - 调试埋点拉取：`dump`；资源导入：`import`
2. **改 project.godot 前必须 `projstop`，改完 `projstart`**（编辑器退出会回写覆盖手改）
3. 属性设值 success ≠ 生效，以读回为准
4. 资源内部结构（动画帧/TileSet 切片/轨道）没有 MCP 工具——手写 `.tres` 文本或代码构建，参考 `docs/recipes.md`
5. 踩坑速查：`docs/pitfalls.md`（先读再动手，能省一小时）

## 调试方法论

1. 数据埋点优先：在代码里 `DebugRing.log(...)`，`gdflow dump` 拉取——不要靠看画面猜
2. 进程级故障（卡 splash/窗口不出）才看屏幕
3. 每完成一个功能：`gdflow check` 主循环无 ERROR 才算完成
4. 游戏改坏了就 `git checkout` 回滚，不要叠加修补

## 代码规约（GDScript）

- Variant 源赋值必须显式类型：`var sc: float = ...`（`:=` 遇 Variant 会 Parse Error）
- Typed Array 传参逐元素显式转换
- 每个节点一个职责；场景树结构优先于代码硬编码

## 带教模式（如果和新人协作）

- 核心玩法代码让新人自己写，AI 只解释/检查/生成非核心资源（占位图、音效）
- 不抢键盘：给"下一句提示"，不给完整答案
- 参考任务卡：`docs/` 里的 task_cards
