#!/usr/bin/env python3
"""gdflow — Godot AI 开发辅助层（单文件零依赖）

把 gdmcp CLI + Godot-MCP-Native 的实战踩坑全部固化成一条命令。
所有项目通用：gdflow.py --project <项目根> [--port N] <命令> [参数...]

命令：
  init                        一键铺设工具链到项目：插件+gdmcp+project.godot 配置+管理器注册+自检
                              （工具源优先级: --source > gdflow.py 同目录/gdflow_assets/ > 管理器工具链缓存）
  status                      doctor + 管理器实例状态
  run                         启动游戏并等待调试探针就绪（自动重试一次）
  stop                        停止游戏 + 清理僵尸游戏进程（动态识别编辑器 PID）
  restart                     stop + run
  check                       主循环加载验证（权威：stderr 无 ERROR 即干净）
  validate <res:///路径>       两级验证：gdmcp validate → 失败时主循环拿详细行号
  setprop <节点路径> <属性> <JSON值>
                              智能属性设置：设置→读回→格式启发重试（数组→对象）→报告
  getprop <节点路径> [属性]    读运行/编辑器节点属性
  call <节点路径> <方法名>     调用运行时节点方法（如 /root/DebugRing dump）
  dump [单例名=DebugRing]     拉取内存环形埋点
  shot [输出路径]             游戏窗口截图（走 LocalAgent 8766，绕过 gdmcp 缓存坑；不可达时自动跳过）
  projstop / projstart        停止 / 启动无头编辑器实例（改 project.godot 前必须 projstop）

环境依赖（均可通过参数覆盖）：
  Godot 路径   --godot 或环境变量 GODOT_PATH，否则按内置候选表探测
  管理器       --manager（默认 http://127.0.0.1:17890，proj*/status/init 用）
  LocalAgent   --agent（默认 http://127.0.0.1:8766，仅 shot 用，不在线不影响其他命令）
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time

GODOT_CANDIDATES = [
    r"F:\ProgramFiles\Steam\steamapps\common\Godot Engine\godot.windows.opt.tools.64.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Programs\Godot\godot.windows.opt.tools.64.exe"),
]
MANAGER = "http://127.0.0.1:17890"
LOCALAGENT = "http://127.0.0.1:8766"


def find_gdmcp(project):
    for rel in (r".gdmcp\bin\gdmcp.exe",):
        p = os.path.join(project, rel)
        if os.path.exists(p):
            return p
    raise SystemExit("未找到 .gdmcp/bin/gdmcp.exe（先运行: gdflow init）")


def find_godot():
    env = os.environ.get("GODOT_PATH")
    cands = ([env] if env else []) + GODOT_CANDIDATES
    for p in cands:
        if p and os.path.exists(p):
            return p
    raise SystemExit("未找到 Godot 可执行文件：用 --godot 指定、设 GODOT_PATH，或把路径加进 GODOT_CANDIDATES")


def find_toolchain_source(explicit=None):
    """定位工具链种子（补丁版插件 + gdmcp.exe + debug_ring.gd）。
    返回 dict: {addons, gdmcp_exe, debug_ring(可为 None)}"""
    candidates = []
    if explicit:
        candidates.append(explicit)
    here = os.path.dirname(os.path.abspath(__file__))
    candidates.append(os.path.join(here, "gdflow_assets"))
    # 管理器工具链缓存（godot-multi-manager 解压产物）
    mgr_cache = os.path.join(here, "godot-multi-manager", "data", "cache")
    if os.path.isdir(mgr_cache):
        candidates.append(mgr_cache)

    def _find(root, name):
        queue = [root]
        while queue:
            d = queue.pop(0)
            try:
                entries = os.listdir(d)
            except OSError:
                continue
            for e in entries:
                full = os.path.join(d, e)
                if os.path.isfile(full) and e == name:
                    return full
                if os.path.isdir(full) and not e.startswith("."):
                    queue.append(full)
        return None

    for c in candidates:
        if not c or not os.path.isdir(c):
            continue
        plugin_cfg = _find(c, "plugin.cfg")
        gdmcp_exe = _find(c, "gdmcp.exe")
        if plugin_cfg and gdmcp_exe:
            addons = os.path.dirname(os.path.dirname(plugin_cfg))  # plugin.cfg 的上级的上级 = godot_mcp/
            if os.path.basename(addons) != "godot_mcp":
                addons = os.path.dirname(plugin_cfg)
            return {"addons": addons, "gdmcp_exe": gdmcp_exe,
                    "debug_ring": _find(c, "debug_ring.gd")}
    raise SystemExit("未找到工具链源（需要 plugin.cfg + gdmcp.exe）：用 --source 指定，"
                     "或在 gdflow.py 同目录放 gdflow_assets/，或先启动管理器让其下载缓存")



def _http_get(url, timeout=10):
    import urllib.request
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _http_post_json(url, obj, timeout=30):
    import urllib.request
    data = json.dumps(obj).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


class Gd:
    def __init__(self, project, port):
        self.project = project
        self.port = port
        self.gdmcp = find_gdmcp(project)
        self.base = ["--url", f"http://127.0.0.1:{port}", "--json", "--timeout", "25"]

    def raw(self, args, timeout=90):
        return subprocess.run([self.gdmcp] + self.base + args,
                              capture_output=True, text=True, timeout=timeout, cwd=self.project)

    def json(self, args, timeout=90):
        r = self.raw(args, timeout)
        try:
            return json.loads(r.stdout)
        except Exception:
            return {"ok": False, "raw": (r.stdout + r.stderr)[:400]}

    def call(self, tool, args=None, apply=False):
        a = ["tool-call", tool]
        if args:
            a += ["--args-json", json.dumps(args)]
        if apply:
            a += ["--apply"]
        return self.json(a)

    # ---------- 实例自动拉起（新手最大坑的消除：实例没跑时一切命令都会失败） ----------
    def _instance_alive(self):
        """MCP 服务可达即视为实例存活（doctor 顶层有 editor_connected 字段）"""
        d = self.json(["doctor"])
        return "editor_connected" in d

    def ensure_instance(self, wait=60.0):
        if self._instance_alive():
            return True
        print("实例未运行，自动拉起无头实例...")
        try:
            self.projstop()
        except Exception:
            pass
        time.sleep(2)
        try:
            self.projstart()
        except SystemExit as e:
            print("自动拉起失败:", e); return False
        deadline = time.time() + wait
        while time.time() < deadline:
            if self._instance_alive():
                print("实例就绪")
                time.sleep(1.5)  # 调试桥稳定窗口
                return True
            time.sleep(1.5)
        print("实例拉起超时——请检查 manager(17890) 是否在跑、godot 路径是否正确")
        return False

    def doctor(self):
        """完整自检：Godot 路径 / gdmcp / 实例 / 插件 / manager / 存档目录"""
        checks = []
        checks.append(("Godot 引擎", os.path.exists(find_godot())))
        checks.append(("gdmcp CLI", os.path.exists(self.gdmcp)))
        alive = self.ensure_instance()
        checks.append(("MCP 实例", alive))
        if alive:
            doc = self.json(["doctor"])
            data = doc
            checks.append(("编辑器连接", bool(data.get("editor_connected"))))
            checks.append(("插件版本", data.get("plugin_version", "?")))
        try:
            st = _http_get(f"{MANAGER}/api/state")
            reg = any(os.path.normcase(p["path"]) == os.path.normcase(self.project) for p in st["projects"])
            checks.append(("管理器注册", reg))
        except Exception:
            checks.append(("管理器(17890)", False))
        user_dir = os.path.expandvars(r"%APPDATA%/Godot/app_userdata")
        checks.append(("Godot 用户目录", os.path.isdir(os.path.expandvars(r"%APPDATA%/Godot/app_userdata"))))
        print("=== gdflow 自检 ===")
        all_ok = True
        for name, ok in checks:
            all_ok = all_ok and ok
            print(f"  [{'OK ' if ok else 'FAIL'}] {name}")
        print("结论:", "全部就绪，可以开发" if all_ok else "存在未就绪项（按 FAIL 项排查）")
        return all_ok

    # ---------- status ----------
    def status(self):
        doc = self.json(["doctor"])
        print("doctor: connected =", doc.get("editor_connected"), "| godot =", doc.get("godot_version"))
        try:
            st = _http_get(f"{MANAGER}/api/state")
            for p in st["projects"]:
                if os.path.normcase(p["path"]) == os.path.normcase(self.project):
                    print("manager:", p["name"], "| id =", p["id"], "| port =", p["port"],
                          "| instances =", [(i["id"], i["mode"], i["status"]) for i in p.get("instances", [])])
        except Exception as e:
            print("manager 不可达（游戏 run/stop 不受影响）:", e)

    # ---------- 生命周期 ----------
    def editor_pid(self):
        """从管理器动态获取本项目的无头编辑器实例 PID（清僵尸时豁免它们）"""
        try:
            st = _http_get(f"{MANAGER}/api/state")
            pids = []
            for p in st["projects"]:
                if os.path.normcase(p["path"]) == os.path.normcase(self.project):
                    pids += [i["pid"] for i in p.get("instances", []) if i["status"] == "running"]
            return set(pids)
        except Exception:
            return set()

    def kill_game_procs(self):
        """杀掉本项目编辑器之外的所有 godot 进程（僵尸游戏窗口）"""
        godot_name = os.path.basename(find_godot())
        ps = ("Get-CimInstance Win32_Process -Filter \"Name='%s'\" | "
              "Select-Object ProcessId,ParentProcessId | ConvertTo-Json" % godot_name)
        r = subprocess.run(["powershell.exe", "-NoProfile", "-Command", ps], capture_output=True, text=True, timeout=30)
        try:
            procs = json.loads(r.stdout)
        except Exception:
            return 0
        if isinstance(procs, dict):
            procs = [procs]
        exempt = self.editor_pid()
        # 再豁免所有被管理器标记 running 的编辑器（含其他项目的）
        try:
            st = _http_get(f"{MANAGER}/api/state")
            for p in st["projects"]:
                for i in p.get("instances", []):
                    if i["status"] == "running":
                        exempt.add(i["pid"])
        except Exception:
            pass
        killed = 0
        for pr in procs:
            if pr["ProcessId"] not in exempt:
                subprocess.run(["taskkill", "/F", "/PID", str(pr["ProcessId"])], capture_output=True)
                killed += 1
        return killed

    def run(self, wait_probe=True, probe_timeout=30.0):
        self.ensure_instance()
        d = self.call("run_project", {"allow_window": True})
        ok = d.get("ok")
        probe = bool((d.get("data") or {}).get("probe_ready"))
        print("run:", ok, "| probe_ready:", probe)
        if not (wait_probe and ok and probe):
            if not ok:
                return False
        if wait_probe and ok:
            deadline = time.time() + probe_timeout
            while time.time() < deadline:
                info = self.json(["runtime", "info"]).get("data") or {}
                if info.get("status") == "success":
                    print("probe ready: fps", info.get("fps"), "| nodes", info.get("node_count"))
                    return True
                time.sleep(1.0)
            print("probe 未就绪（超时）——检查游戏是否卡启动/脚本编译错误（gdflow check）")
            return False
        return True

    def stop(self):
        d = self.call("stop_project", {"allow_window": True})
        time.sleep(1.5)
        killed = self.kill_game_procs()
        print("stopped | 清理僵尸 godot 进程:", killed)

    # ---------- 验证 ----------
    def check(self):
        godot = find_godot()
        r = subprocess.run([godot, "--headless", "--path", self.project, "--quit"],
                           capture_output=True, text=True, timeout=120)
        out = r.stdout + r.stderr
        bad = [l for l in out.splitlines() if "ERROR" in l.upper()]
        print("主循环验证:", "CLEAN" if not bad else "FAIL")
        for l in bad[:6]:
            print("  ", l[:160])
        return not bad

    def validate(self, res_path):
        d = self.json(["scripts", "validate", res_path])
        data = d.get("data") or {}
        if data.get("valid"):
            print("validate: CLEAN")
            return True
        print("validate: FAIL（笼统信息，自动升级主循环拿详细行号）")
        rel = res_path.replace("res://", "").replace("/", os.sep)
        godot = find_godot()
        r = subprocess.run([godot, "--headless", "--path", self.project, "--check-only", "--script", res_path],
                           capture_output=True, text=True, timeout=120)
        detail = [l for l in (r.stdout + r.stderr).splitlines() if "ERROR" in l.upper() or "Parse" in l]
        if not detail:
            # check-only 对引用 autoload 的脚本会误报，且看不到行号时退回主循环
            r2 = subprocess.run([godot, "--headless", "--path", self.project, "--quit"],
                                capture_output=True, text=True, timeout=120)
            detail = [l for l in (r2.stdout + r2.stderr).splitlines() if "ERROR" in l.upper()]
        for l in detail[:6]:
            print("  ", l[:160])
        return False

    # ---------- 属性（智能重试） ----------
    def _get_prop(self, runtime, node, prop):
        cmd = (["runtime", "nodes", "get", node] if runtime
               else ["nodes", "get", node])
        d = self.json(cmd)
        props = (d.get("data") or {}).get("properties") or {}
        return props.get(prop)

    @staticmethod
    def _equal(a, b):
        if isinstance(a, dict) and isinstance(b, dict):
            return all(abs(float(a.get(k, 0)) - float(b.get(k, 0))) < 0.01 for k in b) if b else a == b
        try:
            return abs(float(a) - float(b)) < 0.01
        except Exception:
            return a == b

    def setprop(self, node, prop, value_str, runtime=False, quiet=False):
        try:
            value = json.loads(value_str)
        except Exception:
            value = value_str
        attempts = [value]
        # 启发式：JSON 数组 → 对象格式（Vector2/Color 静默失败的头号来源）
        if isinstance(value, list) and len(value) == 2 and all(isinstance(v, (int, float)) for v in value):
            attempts.append({"x": float(value[0]), "y": float(value[1])})
        if isinstance(value, list) and len(value) == 4 and all(isinstance(v, (int, float)) for v in value):
            attempts.append({"r": value[0], "g": value[1], "b": value[2], "a": value[3]})
        last = None
        for i, cand in enumerate(attempts):
            args = ["nodes", "properties", "set", node, "--property", prop,
                    "--value", json.dumps(cand), "--value-json"]
            if runtime:
                args = ["runtime", "nodes", "set"] + args[4:]
            d = self.json(args)
            got = self._get_prop(runtime, node, prop)
            if d.get("ok") and self._equal(got, cand if not isinstance(cand, dict) else cand):
                if not quiet:
                    print(f"setprop OK（第 {i+1} 种格式）| 读回: {prop} = {json.dumps(got, ensure_ascii=False)[:80]}")
                return True
            last = (d, got)
        if not quiet:
            print(f"setprop FAIL: 该属性可能不支持 MCP 设值（如 PackedVector2Array），改在脚本 _ready() 里构建")
            print("  最后尝试:", json.dumps(last[0], ensure_ascii=False)[:200], "| 读回:", last[1])
        return False

    def setprop_quiet(self, node, prop, value_str, runtime=False):
        return self.setprop(node, prop, value_str, runtime=runtime, quiet=True)

    # ---------- dump / shot ----------
    def dump(self, singleton="DebugRing", retries=3):
        self.ensure_instance()
        res = None
        status = None
        for i in range(retries):
            d = self.json(["runtime", "nodes", "call",
                           "--method", "dump", f"/root/{singleton}"])
            data = d.get("data") or {}
            status = data.get("status")
            res = data.get("result")
            if status == "success" and res is not None:
                break
            time.sleep(2.0)  # 调试桥刚建立时 dump 会超时，等它稳定
        print("dump:", status, ("(第 %d 次尝试)" % (i + 1)) if i else "")
        print(json.dumps(res, ensure_ascii=False, indent=1)[:4000])
        return res

    def shot(self, out=None):
        title = os.path.basename(self.project.rstrip(os.sep)) + " (DEBUG)"
        try:
            cap = _http_post_json(f"{LOCALAGENT}/screen/capture",
                                  {"mode": "window", "window_title": title, "format": "path"})
        except Exception as e:
            print("shot 跳过（LocalAgent 8766 不可达，不影响其他命令）:", e)
            return
        print("shot:", cap.get("path"))

    # ---------- 编辑器实例 ----------
    def _project_id(self):
        st = _http_get(f"{MANAGER}/api/state")
        for p in st["projects"]:
            if os.path.normcase(p["path"]) == os.path.normcase(self.project):
                return p["id"]
        raise SystemExit("项目未在管理器注册")

    def projstop(self):
        pg = os.path.join(self.project, "project.godot")
        hash_before = hashlib.sha256(open(pg, "rb").read()).hexdigest() if os.path.exists(pg) else ""
        pid_id = self._project_id()
        st = _http_get(f"{MANAGER}/api/state")
        for p in st["projects"]:
            if p["id"] == pid_id:
                for i in p.get("instances", []):
                    if i["status"] == "running":
                        import urllib.request
                        req = urllib.request.Request(f"{MANAGER}/api/instances/{i['id']}", method="DELETE")
                        with urllib.request.urlopen(req, timeout=30):
                            pass
        # 回写覆盖检测：实例退出时可能把内存配置写回磁盘，吃掉运行期间的手改
        if os.path.exists(pg):
            hash_after = hashlib.sha256(open(pg, "rb").read()).hexdigest()
            if hash_after != hash_before:
                snap = self._snapshot_path()
                print("⚠️  检测到回写覆盖！project.godot 在实例退出时被改写（运行期间的手改可能丢失）")
                if os.path.exists(snap):
                    print("    上次安全快照: " + snap)
                    print("    确认后可用恢复: gdflow guard --restore")
                else:
                    print("    （无快照可恢复）")
            else:
                self._save_snapshot()  # 未发生回写才更新快照（保留旧快照供恢复）
        print("编辑器实例已停（现在可以安全修改 project.godot）")

    def _snapshot_path(self):
        return os.path.join(self.project, ".gdflow", "project.godot.snap")

    def _save_snapshot(self):
        pg = os.path.join(self.project, "project.godot")
        if os.path.exists(pg):
            os.makedirs(os.path.dirname(self._snapshot_path()), exist_ok=True)
            shutil.copy2(pg, self._snapshot_path())

    def guard_status(self):
        pg = os.path.join(self.project, "project.godot")
        snap = self._snapshot_path()
        if not os.path.exists(snap):
            print("无快照（projstop 会自动创建）")
            return True
        same = open(pg, "rb").read() == open(snap, "rb").read()
        print("project.godot 与安全快照", "一致" if same else "不一致（若为意外回写可 guard --restore）")
        if not same:
            import difflib
            cur = open(pg, encoding="utf-8", errors="replace").read().splitlines()
            old = open(snap, encoding="utf-8", errors="replace").read().splitlines()
            for line in list(difflib.unified_diff(old, cur, "snapshot", "current", lineterm=""))[:20]:
                print("  " + line)
        return same

    def guard_restore(self):
        snap = self._snapshot_path()
        if not os.path.exists(snap):
            raise SystemExit("无快照可恢复")
        shutil.copy2(snap, os.path.join(self.project, "project.godot"))
        print("已从安全快照恢复 project.godot")

    def projstart(self):
        self.projstop()  # 防重：多实例会抢同一项目的 MCP 端口导致游戏秒退
        time.sleep(2)
        pid_id = self._project_id()
        r = _http_post_json(f"{MANAGER}/api/instances", {"projectId": pid_id, "mode": "headless"})
        print("编辑器实例:", r["instance"]["status"])
        time.sleep(6)
        self._save_snapshot()  # 启动成功 = 新的安全基线


# ---------- init：一键铺设工具链 ----------
def _patch_project_godot(pg_path, with_debug_ring):
    """文本方式安全修改 project.godot：启用插件 + 注册 autoload（幂等）。
    返回 [修改说明...]。调用方保证已备份且编辑器实例已停。"""
    with open(pg_path, encoding="utf-8") as f:
        lines = f.read().splitlines()
    notes = []

    def section_index(name):
        for i, l in enumerate(lines):
            if l.strip() == f"[{name}]":
                return i
        return None

    def next_section(i):
        for j in range(i + 1, len(lines)):
            if lines[j].startswith("["):
                return j
        return len(lines)

    # 1) [editor_plugins] enabled
    entry = "res://addons/godot_mcp/plugin.cfg"
    i = section_index("editor_plugins")
    if i is None:
        lines += ["", "[editor_plugins]",
                  f'enabled=PackedStringArray("{entry}")']
        notes.append("已添加 [editor_plugins] 段")
    else:
        seg = range(i + 1, next_section(i))
        hit = False
        for j in seg:
            if lines[j].startswith("enabled="):
                hit = True
                if entry not in lines[j]:
                    lines[j] = lines[j].replace("PackedStringArray(", f'PackedStringArray("{entry}", ', 1)
                    notes.append("已把插件加入 enabled 列表")
                break
        if not hit:
            lines.insert(next_section(i), f'enabled=PackedStringArray("{entry}")')
            notes.append("已添加 enabled 行")

    # 2) [autoload] 注册（用 res:// 路径，不依赖插件 uid）
    autoloads = [("MCPRuntimeProbe", "*res://addons/godot_mcp/runtime/mcp_runtime_probe.gd")]
    if with_debug_ring:
        autoloads.append(("DebugRing", "*res://scripts/debug_ring.gd"))
    i = section_index("autoload")
    if i is None:
        lines += ["", "[autoload]"] + [f'{n}="{p}"' for n, p in autoloads]
        notes.append("已添加 [autoload] 段: " + ", ".join(n for n, _ in autoloads))
    else:
        seg_end = next_section(i)
        existing = {l.split("=")[0].strip() for l in lines[i + 1:seg_end] if "=" in l}
        for n, p in reversed(autoloads):
            if n in existing:
                notes.append(f"autoload {n} 已存在，跳过")
                continue
            lines.insert(seg_end, f'{n}="{p}"')
            notes.append(f"已注册 autoload {n}")
    with open(pg_path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    return notes


def cmd_init(project, port, godot_override=None, source=None, with_debug_ring=True):
    pg = os.path.join(project, "project.godot")
    if not os.path.isfile(pg):
        raise SystemExit(f"不是 Godot 项目（缺 project.godot）: {project}")
    if godot_override:
        GODOT_CANDIDATES.insert(0, godot_override)
    find_godot()  # 早失败

    src = find_toolchain_source(source)
    print(f"工具链源: {os.path.dirname(src['addons'])}")

    # 0) 备份 + 若实例在跑先停（防回写覆盖的关键顺序）
    backup = pg + ".init.bak"
    if not os.path.exists(backup):
        shutil.copy2(pg, backup)
        print("已备份 project.godot ->", os.path.basename(backup))
    try:
        st = _http_get(f"{MANAGER}/api/state", timeout=3)
        for p in st["projects"]:
            if os.path.normcase(p["path"]) == os.path.normcase(project):
                for inst in p.get("instances", []):
                    if inst["status"] == "running":
                        import urllib.request
                        req = urllib.request.Request(f"{MANAGER}/api/instances/{inst['id']}", method="DELETE")
                        with urllib.request.urlopen(req, timeout=30):
                            pass
                        print("已停止运行中的编辑器实例（防回写覆盖）")
                time.sleep(2)
    except Exception:
        print("管理器不可达（继续；若编辑器开着该实例请手动关闭）")

    # 1) 拷贝插件 + gdmcp
    dst_addons = os.path.join(project, "addons", "godot_mcp")
    shutil.copytree(src["addons"], dst_addons, dirs_exist_ok=True)
    print("插件已铺设: addons/godot_mcp/")
    gdmcp_dst = os.path.join(project, ".gdmcp", "bin")
    os.makedirs(gdmcp_dst, exist_ok=True)
    shutil.copy2(src["gdmcp_exe"], os.path.join(gdmcp_dst, "gdmcp.exe"))
    print("gdmcp CLI 已铺设: .gdmcp/bin/gdmcp.exe")

    # 2) DebugRing
    if with_debug_ring:
        if src.get("debug_ring"):
            os.makedirs(os.path.join(project, "scripts"), exist_ok=True)
            shutil.copy2(src["debug_ring"], os.path.join(project, "scripts", "debug_ring.gd"))
            print("DebugRing 埋点单例已铺设: scripts/debug_ring.gd")
        else:
            print("警告: 工具源中没有 debug_ring.gd，跳过（dump 命令将不可用）")
            with_debug_ring = False

    # 3) project.godot
    for n in _patch_project_godot(pg, with_debug_ring):
        print("project.godot:", n)

    # 4) manager 注册
    registered = False
    try:
        st = _http_get(f"{MANAGER}/api/state", timeout=3)
        registered = any(os.path.normcase(p["path"]) == os.path.normcase(project) for p in st["projects"])
        if not registered:
            _http_post_json(f"{MANAGER}/api/projects", {"path": project})
            registered = True
            print("已注册到管理器")
        else:
            print("管理器中已注册，跳过")
    except Exception:
        print("管理器不可达，跳过注册（gdflow run/check 不受影响；proj* 与 Web UI 需要 manager）")

    # 5) 起实例 + 自检
    if registered:
        real_port = resolve_port(project, port)
        print(f"MCP 端口（管理器分配）: {real_port}")
        g = Gd(project, real_port)
        try:
            g.projstart()
        except SystemExit as e:
            print("启动实例失败:", e)
        ok = g.doctor()
        print()
        print("=== init 完成 ===")
        print(f"下一步: python gdflow.py --project <项目根> run   # 跑游戏（端口已可自动识别）")
        sys.exit(0 if ok else 1)
    else:
        print("=== init 完成（未起实例：manager 不可达）===")
        print("manager 在线后运行: gdflow projstart，然后 gdflow doctor")


def resolve_port(project, port=None):
    """--port 未给时从管理器查询该项目分配的端口（新生不必猜端口）。"""
    if port:
        return port
    try:
        st = _http_get(f"{MANAGER}/api/state", timeout=5)
        for p in st["projects"]:
            if os.path.normcase(p["path"]) == os.path.normcase(project):
                return p["port"]
    except Exception:
        pass
    raise SystemExit("无法确定端口：manager 不可达或项目未注册。"
                     "首次使用请先跑 gdflow init，或显式传 --port")


_TEX_TRES = '''[gd_resource type="GradientTexture2D" load_steps=2 format=3]

[sub_resource type="Gradient" id="Gradient_st"]
offsets = PackedFloat32Array(0, 1)
colors = PackedColorArray(0.27, 0.51, 0.86, 1, 0.9, 0.3, 0.3, 1)

[resource]
fill_from = Vector2(0, 0)
fill_to = Vector2(1, 1)
gradient = SubResource("Gradient_st")
width = 32
height = 32
'''

_SF_TRES = '''[gd_resource type="SpriteFrames" load_steps=4 format=3]

[ext_resource type="Texture2D" path="res://tests/_st_tex.tres" id="1_tex"]

[sub_resource type="AtlasTexture" id="AtlasTexture_f0"]
atlas = ExtResource("1_tex")
region = Rect2(0, 0, 16, 16)

[sub_resource type="AtlasTexture" id="AtlasTexture_f1"]
atlas = ExtResource("1_tex")
region = Rect2(16, 0, 16, 16)

[resource]
animations = [{
"frames": [{
"duration": 1.0,
"texture": SubResource("AtlasTexture_f0")
}, {
"duration": 1.0,
"texture": SubResource("AtlasTexture_f1")
}],
"loop": true,
"name": &"st_walk",
"speed": 8.0
}]
'''

_TS_TRES = '''[gd_resource type="TileSet" load_steps=3 format=3]

[ext_resource type="Texture2D" path="res://tests/_st_tex.tres" id="1_tex"]

[sub_resource type="TileSetAtlasSource" id="TileSetAtlasSource_st"]
texture = ExtResource("1_tex")
texture_region_size = Vector2i(16, 16)
0:0/0 = 0
1:0/0 = 0

[resource]
tile_size = Vector2i(16, 16)
sources/0 = SubResource("TileSetAtlasSource_st")
'''

_ANIM_TRES = '''[gd_resource type="Animation" format=3]

[resource]
resource_name = "st_anim"
length = 1.0
loop_mode = 1
tracks/0/type = "value"
tracks/0/imported = false
tracks/0/enabled = true
tracks/0/path = NodePath(".")
tracks/0/interp = 1
tracks/0/loop_wrap = true
tracks/0/keys = {
"times": PackedFloat32Array(0, 0.5, 1),
"transitions": PackedFloat32Array(1, 1, 1),
"update": 0,
"values": [Vector2(0, 0), Vector2(50, 25), Vector2(0, 0)]
}
'''

_CHECK_SCRIPT = '''extends SceneTree
func _init():
	var ok := true
	var sf = load("res://tests/_st_sf.tres")
	print("ST sf_valid=", sf != null, " anims=", sf.get_animation_names() if sf else [],
		" frames=", sf.get_frame_count("st_walk") if sf else 0)
	ok = ok and sf != null and sf.get_frame_count("st_walk") == 2
	var ts = load("res://tests/_st_ts.tres")
	var tiles := 0
	if ts:
		var src = ts.get_source(ts.get_source_id(0))
		tiles = src.get_tiles_count() if src else 0
	print("ST ts_valid=", ts != null, " tiles=", tiles)
	ok = ok and ts != null and tiles == 2
	var an = load("res://tests/_st_anim.tres")
	var anim_tracks := 0
	var anim_keys := 0
	if an:
		anim_tracks = an.get_track_count()
		anim_keys = an.track_get_key_count(0) if anim_tracks > 0 else 0
	print("ST anim_valid=", an != null, " tracks=", anim_tracks, " keys=", anim_keys,
		" len=", an.length if an else 0.0, " loop=", an.loop_mode if an else 0)
	ok = ok and an != null and anim_tracks == 1 and anim_keys == 3
	print("ST result=", "PASS" if ok else "FAIL")
	quit()
'''


def cmd_selftest(project, with_runtime=True):
    """一键回归：把资产域验证固化成 PASS/FAIL 清单。测试产物在 res://tests/_st_*，跑完清理。"""
    godot = find_godot()
    g = Gd(project, resolve_port(project))
    results = []

    def record(name, ok, detail=""):
        results.append(ok)
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail and not ok else ""))

    def headless_check():
        p = os.path.join(project, "tests", "_st_check.gd")
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8", newline="\n") as f:
            f.write(_CHECK_SCRIPT)
        r = subprocess.run([godot, "--headless", "--path", project, "--script", "res://tests/_st_check.gd"],
                           capture_output=True, text=True, timeout=180)
        out = r.stdout + r.stderr
        lines = [l for l in out.splitlines() if l.startswith("ST ")]
        return lines

    print("=== gdflow selftest ===")
    if not g.ensure_instance():
        record("实例就绪", False)
        return False

    tests_dir = os.path.join(project, "tests")
    os.makedirs(tests_dir, exist_ok=True)
    for name, body in (("_st_tex.tres", _TEX_TRES), ("_st_sf.tres", _SF_TRES),
                       ("_st_ts.tres", _TS_TRES), ("_st_anim.tres", _ANIM_TRES)):
        with open(os.path.join(tests_dir, name), "w", encoding="utf-8", newline="\n") as f:
            f.write(body)

    # T1 场景与节点
    d = g.call("create_scene", {"scene_path": "res://tests/_st_scene.tscn", "root_node_type": "Node2D"}, apply=True)
    ok1 = d.get("ok") is True
    record("T1 create_scene", ok1, json.dumps(d.get("error") or {}, ensure_ascii=False)[:120])
    if not ok1:
        return False
    g.call("open_scene", {"scene_path": "res://tests/_st_scene.tscn", "allow_ui_focus": True}, apply=True)
    g.call("create_node", {"parent_path": ".", "node_type": "Sprite2D", "node_name": "ST_Sprite"}, apply=True)

    # T2 属性：数组格式自动重试（Vector2）
    g.setprop_quiet("ST_Sprite", "position", "[3, 4]")
    got = g._get_prop(False, "ST_Sprite", "position") or {}
    record("T2 Vector2 数组→对象重试+读回",
           abs(float(got.get("x", 0)) - 3.0) < 0.01 and abs(float(got.get("y", 0)) - 4.0) < 0.01,
           f"got={got}")

    # T3 资源字符串直通（GradientTexture2D tres，零导入依赖）
    d = g.json(["nodes", "properties", "set", "ST_Sprite", "--property", "texture",
                "--value", "res://tests/_st_tex.tres"])
    got = g._get_prop(False, "ST_Sprite", "texture") or {}
    record("T3 texture 字符串直通",
           bool(d.get("ok")) and got.get("resource_path") == "res://tests/_st_tex.tres",
           f"resp={json.dumps(d)[:120]} got={json.dumps(got)[:120]}")

    # T4/T5 tres 读写（headless 权威验证）
    lines = headless_check()
    sf_line = next((l for l in lines if "sf_valid" in l), "")
    ts_line = next((l for l in lines if "ts_valid" in l), "")
    record("T4 SpriteFrames tres 读写", "frames=2" in sf_line and "sf_valid=true" in sf_line, sf_line)
    record("T5 TileSet tres 读写", "tiles=2" in ts_line and "ts_valid=true" in ts_line, ts_line)

    # T6 Animation tres（值轨道+关键帧）
    an_line = next((l for l in lines if "anim_valid" in l), "")
    record("T6 Animation tres 读写（轨道/关键帧）",
           "anim_valid=true" in an_line and "tracks=1" in an_line and "keys=3" in an_line, an_line)

    # T7 场景保存 + 主循环
    d = g.json(["scenes", "save"])
    record("T7 场景保存", d.get("ok") is True, json.dumps(d)[:150])
    record("T8 主循环 check", g.check())

    # T9 运行时链路（run → dump → stop）
    if with_runtime:
        try:
            ok_run = g.run(wait_probe=True, probe_timeout=40.0)
            time.sleep(1.5)
            ok_dump = False
            if ok_run:
                res = g.dump("DebugRing")
                ok_dump = isinstance(res, (list, dict))
            record("T9 run+dump 运行时链路", ok_run and ok_dump,
                   "" if ok_run and ok_dump else "run 失败或 DebugRing 未安装")
        finally:
            g.stop()
    else:
        print("  [SKIP] T9 run+dump（--no-run）")

    # 清理测试产物
    for f in ("_st_scene.tscn", "_st_tex.tres", "_st_sf.tres", "_st_ts.tres", "_st_anim.tres",
              "_st_check.gd", "_st_icon.png"):
        p = os.path.join(tests_dir, f)
        if os.path.exists(p):
            os.remove(p)
    print("=== selftest 结果:", f"{sum(results)}/{len(results)} PASS", "===")
    return all(results)


def cmd_import(project):
    """资源导入封装：projstop → headless --import → projstart。
    编辑器实例开着时手改 .import / 放新资源，headless 导入会和实例的导入态互相踩，必须走这里。"""
    godot = find_godot()
    g = None
    try:
        g = Gd(project, resolve_port(project))
        g.projstop()
    except SystemExit:
        print("（项目未注册/manager 不可达，跳过实例管理）")
    except Exception as e:
        print("projstop 跳过:", e)
    print("headless 导入中...")
    r = subprocess.run([godot, "--headless", "--path", project, "--import"],
                       capture_output=True, text=True, timeout=600)
    out = r.stdout + r.stderr
    up = out.upper()
    bad = [l for l in out.splitlines()
           if "ERROR" in l.upper()
           and "RESOURCES STILL IN USE" not in l.upper()
           and "OBJECTDB" not in l.upper()]
    print("导入:", "CLEAN（退出时的 leaked/resources-in-use 警告是 headless 噪音，可忽略）" if not bad else "FAIL")
    for l in bad[:6]:
        print("  ", l[:160])
    if g:
        try:
            g.projstart()
        except Exception as e:
            print("projstart 失败（可手动 gdflow projstart）:", e)
    return not bad


def cmd_smoke(project, seconds=6.0, min_fps=30.0, headless=False):
    """冒烟测试：游戏能跑、fps 达标（有头）、stderr 无 ERROR。退出码供 CI。"""
    godot = find_godot()
    if headless:
        # 纯逻辑冒烟：headless 跑主场景 N 秒后杀掉，检查输出无 ERROR
        pg = os.path.join(project, "project.godot")
        main = ""
        for line in open(pg, encoding="utf-8", errors="replace"):
            if line.startswith("run/main_scene"):
                main = line.split("=", 1)[1].strip().strip('"')
                break
        if not main:
            raise SystemExit("project.godot 未设置 run/main_scene")
        r = subprocess.Popen([godot, "--headless", "--path", project, main],
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        time.sleep(seconds)
        r.kill()
        out = r.stdout.read() if r.stdout else ""
        bad = [l for l in out.splitlines() if "ERROR" in l.upper() and "still in use" not in l.lower()]
        print("smoke(headless):", "PASS" if not bad else "FAIL")
        for l in bad[:6]:
            print("  ", l[:160])
        return not bad
    # 有头：真 fps 断言（停完立刻跑会有调试桥竞态，失败自动重试一次）
    g = Gd(project, resolve_port(project))
    try:
        ok_run = g.run(wait_probe=True, probe_timeout=40.0)
        if not ok_run:
            print("smoke: 首次启动探针未就绪（竞态），stop 后重试一次...")
            g.stop()
            time.sleep(2.0)
            ok_run = g.run(wait_probe=True, probe_timeout=40.0)
        if not ok_run:
            print("smoke: FAIL（启动/探针失败）")
            return False
        deadline = time.time() + max(2.0, seconds)
        fps = 0.0
        while time.time() < deadline:
            info = g.json(["runtime", "info"]).get("data") or {}
            if info.get("status") == "success":
                fps = float(info.get("fps") or 0)
            time.sleep(1.0)
        ok = fps >= min_fps
        print(f"smoke: {'PASS' if ok else 'FAIL'} | fps={fps:.0f}（阈值 {min_fps:.0f}）")
        return ok
    finally:
        g.stop()


def main():
    global MANAGER, LOCALAGENT
    ap = argparse.ArgumentParser(description="gdflow — Godot AI 开发辅助层")
    ap.add_argument("--project", required=True)
    ap.add_argument("--port", type=int, help="MCP 端口（可省略：自动从管理器查询）")
    ap.add_argument("--godot", help="Godot 可执行路径（默认按内置候选表+GODOT_PATH 探测）")
    ap.add_argument("--manager", help="godot-multi-manager 地址（默认 http://127.0.0.1:17890）")
    ap.add_argument("--agent", help="LocalAgent 地址（默认 http://127.0.0.1:8766，仅 shot 用）")
    sub = ap.add_subparsers(dest="cmd", required=True)
    it = sub.add_parser("init", help="一键铺设工具链到项目")
    it.add_argument("--source", help="工具链种子目录（含 godot_mcp 插件 + gdmcp.exe）")
    it.add_argument("--no-debug-ring", action="store_true", help="不安装 DebugRing 埋点单例")
    sub.add_parser("status")
    sub.add_parser("doctor")
    sub.add_parser("run")
    sub.add_parser("stop")
    sub.add_parser("restart")
    sub.add_parser("check")
    v = sub.add_parser("validate"); v.add_argument("path")
    sp = sub.add_parser("setprop"); sp.add_argument("node"); sp.add_argument("prop"); sp.add_argument("value")
    gp = sub.add_parser("getprop"); gp.add_argument("node"); gp.add_argument("prop", nargs="?")
    c = sub.add_parser("call"); c.add_argument("node"); c.add_argument("method")
    dp = sub.add_parser("dump"); dp.add_argument("singleton", nargs="?", default="DebugRing")
    sp2 = sub.add_parser("shot"); sp2.add_argument("out", nargs="?")
    sub.add_parser("projstop"); sub.add_parser("projstart")
    sub.add_parser("import", help="安全资源导入（停实例→headless --import→起实例）")
    st = sub.add_parser("selftest", help="一键回归套件（属性/直通/tres/场景/运行时链路）")
    st.add_argument("--no-run", action="store_true", help="跳过 run+dump 运行时链路")
    sm = sub.add_parser("smoke", help="冒烟测试（fps 断言 / headless 逻辑冒烟）")
    sm.add_argument("--seconds", type=float, default=6.0)
    sm.add_argument("--min-fps", type=float, default=30.0)
    sm.add_argument("--headless", action="store_true", help="纯逻辑冒烟（不弹窗，stderr 无 ERROR 即过）")
    gd = sub.add_parser("guard", help="project.godot 回写覆盖防护")
    gd.add_argument("--restore", action="store_true", help="从安全快照恢复")
    a = ap.parse_args()

    if a.manager:
        MANAGER = a.manager
    if a.agent:
        LOCALAGENT = a.agent

    if a.cmd == "init":
        cmd_init(a.project, a.port, godot_override=a.godot,
                 source=a.source, with_debug_ring=not a.no_debug_ring)
        return

    g = Gd(a.project, resolve_port(a.project, a.port))
    if a.cmd == "status": g.status()
    elif a.cmd == "doctor": sys.exit(0 if g.doctor() else 1)
    elif a.cmd == "run": g.run()
    elif a.cmd == "stop": g.stop()
    elif a.cmd == "restart": g.stop(); g.run()
    elif a.cmd == "check": sys.exit(0 if g.check() else 1)
    elif a.cmd == "validate": sys.exit(0 if g.validate(a.path) else 1)
    elif a.cmd == "setprop": g.setprop(a.node, a.prop, a.value)
    elif a.cmd == "getprop":
        props = g._get_prop(False, a.node, a.prop) if a.prop else None
        print(json.dumps(props, ensure_ascii=False, indent=1)[:2000])
    elif a.cmd == "call": print(json.dumps(g.json(["runtime", "nodes", "call", "--method", a.method, a.node]), ensure_ascii=False)[:3000])
    elif a.cmd == "dump": g.dump(a.singleton)
    elif a.cmd == "shot": g.shot(a.out)
    elif a.cmd == "projstop": g.projstop()
    elif a.cmd == "projstart": g.projstart()
    elif a.cmd == "import": sys.exit(0 if cmd_import(a.project) else 1)
    elif a.cmd == "selftest": sys.exit(0 if cmd_selftest(a.project, with_runtime=not a.no_run) else 1)
    elif a.cmd == "smoke": sys.exit(0 if cmd_smoke(a.project, a.seconds, a.min_fps, a.headless) else 1)
    elif a.cmd == "guard":
        if a.restore:
            g.guard_restore()
        else:
            sys.exit(0 if g.guard_status() else 1)


if __name__ == "__main__":
    main()
