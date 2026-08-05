# 分镜大师旅游版 — 升级流程

本文档涵盖旅游版的两种升级链路：

- **程序本体升级**：构建 → 上传 → 版本检测 → 下载 → 安装
- **技能升级**：SKILL.md 迭代 → 打包上传 → 客户端自动检测更新

> 本文档是短视频版 `docs/shengji.md` 的旅游版适配副本。所有路径、文件名、品牌标识均已替换为旅游版。

---

## 一、架构总览

```
开发机                       服务器                          用户机器
───────                     ────────                        ────────
1. npm run release          2. GitHub Actions              3. 分镜大师旅游版启动
   打 tag 推远端               自动构建 .dmg                  check_for_upgrade()
                                                           ↓
4. npm run tauri build      5. 上传 .exe 到服务器             发现新版本
   本地构建 Windows NSIS       /jy/uploads/app/              弹 UpdateAvailableDialog
                              安装包上传到服务器
                                                           ↓
                            6. 更新 version_travel.json      用户点击"直接下载安装"
                                                           download_upgrade()
                                                           ↓
                                                           emit download-progress
                                                           进度条实时显示
                                                           ↓
                                                           launch_installer()
                                                           启动 NSIS 安装程序
                                                           当前进程 exit(0)
                                                           ↓
                                                           用户走完 NSIS 安装向导
                                                           新版本覆盖安装完成
```

### 关键文件清单

| 层 | 文件 | 作用 |
|----|------|------|
| 版本检测 JSON | `https://aixiaoxi.top/jy/uploads/app/version_travel.json` | 服务器上存放最新版本信息 |
| Rust 命令 | `src-tauri/src/commands/update.rs` | 版本比较、下载、启动安装程序 |
| Rust 注册 | `src-tauri/src/lib.rs` | 注册 Tauri 命令 |
| 前端命令 | `src/commands/update.ts` | `checkForUpgrade()` 封装 |
| 前端 UI | `src/components/UpdateAvailableDialog.tsx` | 升级弹窗 + 进度条 |
| 前端入口 | `src/App.tsx` | 启动时调用 `checkForUpgrade` |
| 构建配置 | `src-tauri/tauri.conf.json` | NSIS 安装模式 |
| 版本同步 | `scripts/sync-version.mjs` | 同步 package.json / Cargo.toml / tauri.conf.json |
| CI/CD | `.github/workflows/build.yml` | tag 推送 → GitHub Actions 自动构建 macOS DMG |

---

## 二、服务器端：版本信息 JSON

### 2.1 文件位置

```
https://aixiaoxi.top/jy/uploads/app/version_travel.json
```

### 2.2 JSON 格式

```json
{
  "version": "1.0.0",
  "releaseDate": "2026-07-29",
  "downloadUrl": "https://aixiaoxi.top/jy/uploads/app",
  "notes": "## 新增\n- xxx功能\n## 修复\n- yyy问题"
}
```

### 2.3 字段说明

| 字段 | 必需 | 说明 |
|------|------|------|
| `version` | 是 | 最新版本号，不带 `v` 前缀。客户端用语义版本比较（major.minor.patch） |
| `releaseDate` | 是 | 发布日期，展示用 |
| `downloadUrl` | 是 | 安装包所在目录的 **基础 URL**（不含文件名）。文件名由客户端按规则拼接 |
| `notes` | 否 | 更新日志，Markdown 格式。**不能出现模型名称** |

### 2.4 安装包命名规则

客户端根据操作系统自动拼接文件名：

- **Windows**: `Storyboard-Travel_{version}_x64-setup.exe`
- **macOS**: `Storyboard-Travel_{version}_universal.dmg`

代码位置：`src-tauri/src/commands/update.rs` → `installer_name()`

### 2.5 上传新版本的步骤

1. 构建安装包（见第三节）
2. 将安装包上传到 `https://aixiaoxi.top/jy/uploads/app/` 目录
3. 确保安装包同时有带版本号的文件名副本（如 `Storyboard-Travel_1.0.0_x64-setup.exe`）
4. 编辑 `version_travel.json`，更新 `version`、`releaseDate`、`notes` 字段
5. 上传新的 JSON 覆盖旧文件

---

## 三、构建安装包

### 3.1 前提条件

- Windows 构建机需安装 NSIS
- Rust 工具链已安装
- Node.js 20+

### 3.2 Windows NSIS 构建（本地）

```bash
npm run tauri build
```

构建产物：
```
src-tauri/target/release/bundle/nsis/分镜大师旅游版_{version}_x64-setup.exe
```

### 3.3 macOS 构建（GitHub Actions 自动）

macOS DMG 由 GitHub Actions 在 tag 推送后自动触发。

- 触发条件：`git push {remote} v{版本号}`
- 配置文件：`.github/workflows/build.yml`
- 产物：`Storyboard-Travel_{version}_universal.dmg`

---

## 四、版本发布流程

### 阶段一：本地测试构建

#### 步骤 1：准备发布日志

创建 `docs/releases/v{版本号}.md`，格式：

```markdown
## 新增
- 功能A描述

## 修复
- 修复D描述
```

> **铁律：发布日志中绝对不能出现模型名称。**

#### 步骤 2：预检

```bash
npx tsc --noEmit
cd src-tauri && cargo check
```

#### 步骤 3：本地构建

```bash
npm run tauri build
```

#### 步骤 4：本地测试

构建产物：`src-tauri/target/release/bundle/nsis/分镜大师旅游版_{version}_x64-setup.exe`

1. 双击安装包覆盖安装旧版本
2. 启动新版本，验证核心链路（登录 → 对话 → 宫格生成 → 视频生成）
3. 验证数据不丢失

### 阶段二：正式发布

#### 步骤 5：执行发布命令

```bash
npm run release -- patch --notes-file docs/releases/v1.0.1.md
```

#### 步骤 6：上传安装包到服务器

1. 上传 NSIS 安装包到 `/jy/uploads/app/`
2. 确保有英文名副本：`Storyboard-Travel_{version}_x64-setup.exe`
3. 更新 `version_travel.json`
4. 上传新 JSON 覆盖旧文件

```bash
# 示例
scp "分镜大师旅游版_1.0.1_x64-setup.exe" root@47.108.237.10:/jy/uploads/app/
ssh root@47.108.237.10 "cp /jy/uploads/app/分镜大师旅游版_1.0.1_x64-setup.exe /jy/uploads/app/Storyboard-Travel_1.0.1_x64-setup.exe"
scp version_travel.json root@47.108.237.10:/jy/uploads/app/
```

#### 步骤 7：验证

1. 旧版本客户端启动 → 弹升级对话框 → 下载安装验证完整链路
2. 浏览器访问 `https://aixiaoxi.top/jy/uploads/app/version_travel.json` → 确认版本号

---

## 五、版本号同步机制

发布时以下文件**必须**版本号一致：

| 文件 | 版本字段位置 |
|------|-------------|
| `package.json` | `version` |
| `src-tauri/Cargo.toml` | `[package].version` |
| `src-tauri/tauri.conf.json` | `version` |

`scripts/sync-version.mjs` 负责三文件同步。

---

## 六、技能升级流程（xiaoya-ai-cinema-travel）

### 6.1 架构概览

```
开发机                             服务器                              用户机器
───────                            ────────                            ────────
1. 修改 SKILL.md                   2. 打包 zip 上传                      3. 启动时自动同步
   + version.txt                   47.108.237.10                       对比本地 ~/.claude/skills/
   docs/skills/                     /jy/uploads/install_guide/files/    .../version.txt vs 服务器
                                   xiaoya-ai-cinema-travel.zip          version_travel.txt
                                   version_travel.txt                   ↓
                                                                  发现新版本 → 自动下载解压
```

### 6.2 本地文件位置

| 文件 | 路径 |
|------|------|
| Skill 源文件 | `D:\Story-Travel\docs\skills\SKILL.md` |
| 版本文件 | `D:\Story-Travel\docs\skills\version.txt` |
| Skill zip | `D:\Story-Travel\docs\skills\xiaoya-ai-cinema-travel.zip` |

### 6.3 服务器文件位置

| 文件 | URL |
|------|-----|
| Skill zip | `https://aixiaoxi.top/jy/uploads/install_guide/files/xiaoya-ai-cinema-travel.zip` |
| 版本文件 | `https://aixiaoxi.top/jy/uploads/install_guide/files/version_travel.txt` |

### 6.4 发版步骤

```bash
# 1. 修改 SKILL.md + version.txt
# 2. 打包
cd D:\Story-Travel\docs\skills
powershell -Command "Compress-Archive -Path 'SKILL.md','version.txt' -DestinationPath 'xiaoya-ai-cinema-travel.zip' -Force"

# 3. 上传
scp xiaoya-ai-cinema-travel.zip root@47.108.237.10:/jy/uploads/install_guide/files/
scp version.txt root@47.108.237.10:/jy/uploads/install_guide/files/version_travel.txt

# 4. 验证
ssh root@47.108.237.10 "unzip -p /jy/uploads/install_guide/files/xiaoya-ai-cinema-travel.zip version.txt | head -5"
```

### 6.5 关键约束

- **生产服务器**: `47.108.237.10`
- **安全标记**: `<!-- SECURITY_MARKER: xiaoya-ai-cinema-travel-protected-skill-v{X.Y.Z} -->` 必须与 `version.txt` 版本号一致
- **version_travel.txt**: 与 zip 包内的 version.txt 内容相同，用于客户端版本检测

---

## 七、故障排查

| 现象 | 可能原因 | 解决方法 |
|------|---------|---------|
| 不弹升级框 | `version_travel.json` 未更新或版本号不高于当前 | 检查 JSON 文件和版本比较逻辑 |
| 下载失败（1392 错误） | 安装包文件名不匹配或未上传英文副本 | 确认服务器上有 `Storyboard-Travel_{version}_x64-setup.exe` |
| "文件校验失败" | 下载不完整 | 重新上传安装包 |
| 安装程序启动后无反应 | 旧进程未退出 | 确认 `std::process::exit(0)` 执行 |
