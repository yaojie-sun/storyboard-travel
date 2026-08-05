# 分镜大师 - 开发服务器设置指南

## 概述

本指南介绍如何启动开发服务器以运行和调试"分镜大师"应用程序，并显示完整的调试和错误信息。

## 系统要求

- Node.js (v18或更高版本)
- npm (随Node.js一起安装)
- Tauri CLI (v2或更高版本)
- Rust (用于Tauri后端)

## 启动开发服务器

### 方法一：使用批处理文件 (推荐 - Windows)

1. 双击运行 `dev-server.bat`
2. 或在命令行中执行：
   ```cmd
   dev-server.bat
   ```

### 方法二：使用PowerShell脚本

1. 在PowerShell中运行：
   ```powershell
   .\dev-server.ps1
   ```

### 方法三：手动启动

如果您不想使用脚本，可以手动启动开发服务器：

1. 设置环境变量：
   ```cmd
   set RUST_BACKTRACE=full
   set TAURI_DEBUG=1
   set NODE_ENV=development
   ```

2. 启动开发服务器：
   ```cmd
   npm run tauri dev
   ```

## 调试信息说明

启动开发服务器后，您将在CMD窗口中看到以下类型的调试信息：

### Rust/Tauri后端信息
- `INFO` - 常规操作信息
- `DEBUG` - 详细调试信息
- `ERROR` - 错误信息
- `WARN` - 警告信息

### 前端(Vite)信息
- 服务器启动信息
- 文件变更热重载信息
- 构建进度信息

### 分镜大师专用调试信息
- API调用信息
- 用户认证状态
- 次数管理信息
- 图像生成流程

## 日志文件

除了控制台输出外，部分调试信息还会保存到日志文件：
- Windows: `%TEMP%\storyboard-copilot\logs\storyboard.log`

## 常见问题解决

### 1. 端口占用问题
如果端口9999被占用，系统会自动分配新端口。

### 2. 权限问题
确保以管理员身份运行脚本，以避免文件访问问题。

### 3. 依赖安装问题
如果遇到依赖问题，尝试：
```cmd
npm install
cd src-tauri
cargo build
```

## 开发技巧

### 实时调试
- 在开发服务器运行时，修改前端代码会自动热重载
- 修改Rust代码会触发重新编译

### 调试选项
- 设置 `RUST_LOG=debug` 可获得更多Rust调试信息
- 设置 `TAURI_DEBUG=1` 可获得更多Tauri调试信息

## 停止开发服务器

按 `Ctrl+C` 两次来停止开发服务器。

## 故障排除

如果开发服务器启动失败，请检查：

1. Node.js和npm是否正确安装
2. Tauri CLI是否正确安装
3. Rust是否正确安装
4. 防火墙是否阻止了必要的网络连接
5. 杀毒软件是否阻止了程序运行

更多帮助，请参考Tauri官方文档。