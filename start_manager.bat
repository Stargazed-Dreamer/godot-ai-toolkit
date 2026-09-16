@echo off
chcp 936 >nul
cd /d %~dp0manager
echo === Godot 管理器启动中，浏览器打开 http://127.0.0.1:17890 ===
node server.mjs
pause
