# 小鸭服饰版 — 代码详情与完成状态

## 目录

`D:\Story-Fashion` — 从旅游版 `D:\Story-Travel` 复制并定制

## 版本信息

| 项 | 值 |
|------|------|
| productName | `小鸭服饰版` |
| identifier | `com.storyboard.fashion` |
| npm name | `storyboard-fashion` |
| Rust lib | `storyboard_fashion_lib` |
| Vite port | `9997` |
| 版本 | `1.0.0` |

## 已完成定制的文件

### 1. 品牌标识 ✅

| 文件 | 改动 |
|------|------|
| `src-tauri/tauri.conf.json` | productName → 小鸭服饰版, identifier → com.storyboard.fashion, port → 9997 |
| `package.json` | name → storyboard-fashion |
| `src-tauri/Cargo.toml` | name → storyboard-fashion, lib → storyboard_fashion_lib |
| `src-tauri/src/main.rs` | crate → storyboard_fashion_lib |
| `src-tauri/src/lib.rs` | log paths → storyboard-fashion |
| `index.html` | title → 小鸭服饰版 |
| `vite.config.ts` | port → 9997 |
| `.github/workflows/build.yml` | name → Build Storyboard-Fashion, RELEASE_APP_NAME → Storyboard-Fashion |

### 2. 行业预设 ✅

**文件**: `src/features/project/presets.ts`

核心导出（已全部替换为服饰版）：
- `FASHION_STYLE_PRESETS` — 10种服饰风格预设（高级时装T台/日常通勤穿搭/街头潮流穿搭/法式优雅穿搭/韩系温柔穿搭等）
- `FASHION_VIDEO_TYPES` — 6种服饰视频类型：catwalk/outfit/detail/mixmatch/lookbook/fabric
- `EMPHASIS_DIMENSIONS` — 10种服饰重点维度：silhouette/fabric_drape/color_match/movement/detail_focus/lighting_fabric/layering/accessory/style_consistency/occasion_fit
- `getVideoTypeLabel()` / `getEmphasisLabels()` — 标签映射函数

### 3. SKILL.md ✅

**文件**: `docs/skills/SKILL.md` (300+行)

核心内容：
- **AI角色**: 服装展示导演
- **核心能力**: 版型阅读/面料翻译/模特调度/穿搭逻辑
- **6种视频类型**: T台走秀/穿搭展示/细节特写/一衣多穿/LOOKBOOK/面料动态
- **六宫格叙事**: 服装呈现旅程（整体→细节→动态→CTA）
- **人物走位**: 5种路径（直线前进/L型转身/圆形环绕/S型曲线/坐姿切换）
- **动作规范**: 7种展示动作（自然转身/单手插袋/轻抚面料/整理衣领/回眸/自然行走/轻微摆动）
- **运镜**: 10种服饰专属运镜
- **风格模板**: 6种（T台/穿搭/细节/一衣多穿/LOOKBOOK/面料）
- **完整示例**: T台走秀(12秒) + 穿搭展示(10秒)
- **强制规则**: 服装=唯一主角(面部<20%)、时装写实锁死、禁止服装变形

### 4. 规则文件 ✅

| 文件 | 说明 |
|------|------|
| `public/grid_prompt_rules_fashion.json` | 服饰版宫格规则 v1-fashion：服装呈现旅程替代空间递进，面料一致性替代地标锚定 |
| `public/video_gen_rules_fashion.json` | 从旅游版复制，待进一步定制 |
| `public/version_fashion.json` | 应用升级检测 |

### 5. Rust 后端 ✅

| 文件 | 改动 |
|------|------|
| `src-tauri/src/commands/update.rs` | VERSION_CHECK_URL → version_fashion.json, 规则文件 → fashion, installer → Storyboard-Fashion |
| `src-tauri/src/commands/chat.rs` | SKILL → xiaoya-ai-cinema-fashion, SKILL_VERSION_URL → version_fashion.txt |
| `src-tauri/src/commands/banana_api.rs` | User-Agent → Storyboard-Fashion/1.0, SKILL 路径 → xiaoya-ai-cinema-fashion |

### 6. i18n ✅

| 文件 | 改动 |
|------|------|
| `src/i18n/locales/zh.json` | 分镜大师旅游版 → 小鸭服饰版 |
| `src/i18n/locales/en.json` | Storyboard Travel → Storyboard Fashion |

### 7. Git ✅

- Git 已初始化
- 主分支: `main`
- 已提交初始 commit: "小鸭服饰版 v1.0.0 — 初始发布"

---

## TypeScript 编译

✅ 零错误（`npx tsc --noEmit`）

注意：`@xyflow/react` 版本已锁定为 `12.10.1`（与旅游版一致），避免类型不兼容。

---

## 编译问题（已全部修复 ✅）

### 1. icon.ico 格式问题 ✅ 已修复

**问题**: `icon.ico` 实际是 PNG 文件（header 为 `\x89PNG`），Windows RC 编译器要求 3.00 格式。

**修复**: 用 Node.js 脚本从 PNG 源文件（32x32.png, 128x128.png, 128x128@2x.png）生成标准 ICO 文件：
- ICO header（6 字节）+ 3× ICONDIRENTRY（16 字节）+ PNG 数据
- 每个 entry 的 offset 指向对应 PNG 的嵌入位置

### 2. Tauri 版本不匹配 ✅ 已修复

**问题**: npm 包版本（`@tauri-apps/api@2.11.1`, `@tauri-apps/plugin-dialog@2.7.2`）与 Rust crate（`tauri@2.10.2`, `tauri-plugin-dialog@2.6.0`）不一致。

**修复**:
```bash
npm install @tauri-apps/api@2.10.1 @tauri-apps/plugin-dialog@2.6.0
```

### 3. npm 包安装 ✅ 已完成

首次运行：
```bash
cd D:\Story-Fashion
npm install
```

---

## 运行与构建

```bash
# 开发模式
cd D:\Story-Fashion
npm run tauri dev

# 类型检查
npx tsc --noEmit

# Rust 检查
cd src-tauri && cargo check

# Windows 构建
npm run tauri build
# 产物: src-tauri/target/release/bundle/nsis/小鸭服饰版_1.0.0_x64-setup.exe
```

---

## 与旅游版的主要差异对照

| 维度 | 旅游版 (D:\Story-Travel) | 服饰版 (D:\Story-Fashion) |
|------|--------------------------|---------------------------|
| identifier | com.storyboard.travel | com.storyboard.fashion |
| 端口 | 9998 | 9997 |
| 视频类型 | 酒店宣传片/探店/景区/打卡/美食/文化古迹 | T台走秀/穿搭/细节/一衣多穿/LOOKBOOK/面料 |
| AI角色 | 旅游短视频策划专家 | 服装展示导演 |
| 核心叙事 | 空间递进（外→内） | 服装呈现旅程（整体→细节→动态） |
| 人物角色 | 游客/体验者 | 模特/穿着载体 |
| 运镜核心 | 无人机/POV/延时 | 跟拍/环绕/面料特写 |
| 动作规范 | 自然行走 | 5种走位路径 + 7种展示动作 |
| 写实规则 | 禁止CG地标/建筑变形 | 禁止服装变形/颜色偏移/Logo模糊/缝线消失 |
| 负面词 | 地标变形/坏天气/阴天 | 服装变形/面料图案漂移/纽扣错位/拉链扭曲 |

---

## 服务端待部署文件

| 本地文件 | 服务器路径 |
|---------|-----------|
| `docs/skills/xiaoya-ai-cinema-fashion.zip` | `/jy/uploads/install_guide/files/` |
| `docs/skills/version.txt` | `/jy/uploads/install_guide/files/version_fashion.txt` |
| `public/version_fashion.json` | `/jy/uploads/app/version_fashion.json` |
| `public/video_gen_rules_fashion.json` | `/jy/uploads/app/video_gen_rules_fashion.json` |
| `public/grid_prompt_rules_fashion.json` | `/jy/uploads/app/grid_prompt_rules_fashion.json` |

> Skill zip 待打包：`cd D:\Story-Fashion\docs\skills && powershell -Command "Compress-Archive -Path 'SKILL.md','version.txt' -DestinationPath 'xiaoya-ai-cinema-fashion.zip' -Force"`
