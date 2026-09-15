extends Node

## 内存环形埋点单例：零磁盘写入，Agent 经 gdmcp runtime nodes call --method dump /root/DebugRing 拉取。
## 跨局统计（reload_current_scene 不清空 autoload）。游戏脚本中用 DebugRing.dbg("...") 写入。

const MAX := 500

var ring: Array[String] = []
var deaths := 0
var runs := 0

func dbg(line: String) -> void:
	ring.append("%d %s" % [Time.get_ticks_msec(), line])
	if ring.size() > MAX:
		ring.pop_front()

func dump() -> Dictionary:
	return {
		"uptime_s": Time.get_ticks_msec() / 1000.0,
		"runs": runs,
		"deaths": deaths,
		"node_count": get_tree().get_node_count(),
		"mem_mb": OS.get_static_memory_usage() / 1048576,
		"fps": Engine.get_frames_per_second(),
		"ring": ring,
	}
