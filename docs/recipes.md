# AI 组装配方（recipes）

> 给 AI Agent 的可直接套用模式。每个配方都实测过。

## 配方 1：新项目接入工具链

```bash
python gdflow.py --project <项目根> init
# 自动：铺插件 + gdmcp.exe + DebugRing + 配置 project.godot + 注册管理器 + 起实例 + doctor 验收
# 之后所有命令不用再传 --port（自动从管理器查询）
```

## 配方 2：建场景 + 设资源属性（全 MCP）

```bash
# 1. 目录必须先存在（res://scenes/ 不存在时 create_scene 报 Can't open）
mkdir -p <项目>/scenes

# 2. 建场景（写盘，不打开）
gdmcp tool-call create_scene --args-json '{"scene_path":"res://scenes/main.tscn","root_node_type":"Node2D"}' --apply

# 3. 打开（Vibe Coding 下需要 allow_ui_focus）
gdmcp tool-call open_scene --args-json '{"scene_path":"res://scenes/main.tscn","allow_ui_focus":true}' --apply

# 4. 建节点（parent 用 "." 表示当前场景根）
gdmcp tool-call create_node --args-json '{"parent_path":".","node_type":"Sprite2D","node_name":"Ball"}' --apply

# 5. 资源属性字符串直通
gdmcp nodes properties set Ball --property texture --value "res://assets/ball.png"

# 6. 保存（scenes save 不带 --apply）
gdmcp scenes save
```

## 配方 3：帧动画 —— 手写 .tres（AI 最强路径）

MCP 改不了 SpriteFrames 内部帧，但 .tres 是纯文本，AI 直接写（实测 4 帧 walk 动画全通）：

```ini
[gd_resource type="SpriteFrames" load_steps=6 format=3]

[ext_resource type="Texture2D" path="res://assets/walk_sheet.png" id="1_sheet"]

[sub_resource type="AtlasTexture" id="AtlasTexture_f0"]
atlas = ExtResource("1_sheet")
region = Rect2(0, 0, 32, 32)

# ... f1/f2/f3 同理，region.x 依次 +32

[resource]
animations = [{
"frames": [{
"duration": 1.0,
"texture": SubResource("AtlasTexture_f0")
}, {
"duration": 1.0,
"texture": SubResource("AtlasTexture_f1")
}, {
"duration": 1.0,
"texture": SubResource("AtlasTexture_f2")
}, {
"duration": 1.0,
"texture": SubResource("AtlasTexture_f3")
}],
"loop": true,
"name": &"walk",
"speed": 8.0
}]
```

写完直接挂：`gdmcp nodes properties set Walker --property sprite_frames --value "res://resources/walk.tres"`。
验证一行脚本（`--headless --script`）：

```gdscript
extends SceneTree
func _init():
    var sf = load("res://resources/walk.tres")
    print(sf.get_animation_names(), sf.get_frame_count("walk"))
    quit()
```

## 配方 4：TileSet + 摆格子

手写 tileset.tres（`x:y/0 = 0` 就是声明"这里有个图块"）：

```ini
[gd_resource type="TileSet" load_steps=3 format=3]

[ext_resource type="Texture2D" path="res://assets/tiles.png" id="1_tiles"]

[sub_resource type="TileSetAtlasSource" id="TileSetAtlasSource_main"]
texture = ExtResource("1_tiles")
texture_region_size = Vector2i(16, 16)
0:0/0 = 0
1:0/0 = 0
0:1/0 = 0
1:1/0 = 0

[resource]
tile_size = Vector2i(16, 16)
sources/0 = SubResource("TileSetAtlasSource_main")
```

摆格子二选一：
- **TileMap（老节点）**：MCP runtime 工具直接摆（游戏运行中）
  ```bash
  gdmcp tool-call --allow-open-world set_runtime_tilemap_cell --args-json \
    '{"node_path":"/root/主场景/Ground","coords":{"x":0,"y":0},"source_id":0,"atlas_coords":{"x":1,"y":0}}'
  ```
- **TileMapLayer（4.3+ 推荐）**：插件暂不支持，代码摆（同样是教学正解）：
  ```gdscript
  func _ready() -> void:
      for x in range(20):
          set_cell(Vector2i(x, 5), 0, Vector2i(0, 0))  # 源0的(0,0)图块铺地面
  ```

## 配方 5：音频循环

改 `assets/bgm.wav.import`（纯文本）：`edit/loop_mode=2`（2=Forward！枚举是 0=Detect/1=Disabled/2=Forward/3=PingPong/4=Backward），然后 `gdflow import`。
挂载：`nodes properties set Bgm --property stream --value "res://assets/bgm.wav"`。

## 配方 6：调试探针

DebugRing autoload 安装后，游戏代码任意位置：

```gdscript
DebugRing.log("score=%d" % score)      # 进内存环形缓冲（上限500条）
DebugRing.log({"pos": position, "vel": velocity})
```

拉取（游戏运行中）：`gdflow dump`。零磁盘写入，不会伤硬盘。

## 通用原则

1. **先 gdflow 后 gdmcp**：run/stop/check/validate/setprop/dump/import 全走 gdflow
2. **写后必读回**：属性设值 success ≠ 生效
3. **资源内部结构 = tres 文本 or 代码**，不找 MCP 工具
4. **主循环 check 是权威验证**：`gdflow check` stderr 无 ERROR 即干净
