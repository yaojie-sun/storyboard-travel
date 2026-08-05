# 分镜大师 - 开发服务器快速启动

## 快速启动命令

### Windows CMD:
```cmd
npm run tauri dev
```

### PowerShell:
```powershell
npm run tauri dev
```

## 启动脚本

项目中提供了两个启动脚本：

1. `start-dev.bat` - 简化版CMD启动脚本
2. `start-dev.ps1` - 简化版PowerShell启动脚本
3. `dev-server.bat` - 完整版CMD启动脚本（带环境检查）
4. `dev-server.ps1` - 完整版PowerShell启动脚本（带环境检查）

## 调试信息配置

启动时会自动启用以下调试选项：
- `RUST_BACKTRACE=full` - 完整Rust错误追踪
- `RUST_LOG=debug` - 详细的Rust日志输出
- `TAURI_DEBUG=1` - Tauri调试信息
- `VITE_TAURI_DEBUG=1` - Vite-Tauri集成调试信息

## 开发服务器特性

- 自动热重载 (文件更改时自动刷新)
- 完整的错误和调试输出
- 实时编译反馈
- 与前端开发服务器集成

## 注意事项

- 第一次运行可能需要较长时间（下载依赖、编译Rust代码）
- 确保防火墙不会阻止开发服务器
- 如遇端口冲突，系统会自动分配新端口