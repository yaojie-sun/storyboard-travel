# 分镜大师旅游版 — 项目说明书

## 概述

从"分镜大师短视频版"（企业通用版，`D:\Story-ShortVideo`）完整复制的独立应用，针对**旅游行业**做深度定制。共享短视频版的服务端基础设施（用户认证/积分扣减/模型调用），在前端预设、Skill提示词、视频生成规则层做旅游专业化。

## 版本

- **应用版本**：1.0.0
- **Skill 版本**：v1.0.0
- **规则版本**：v1
- **创建日期**：2026-07-29

---

## 核心定制点

### 品牌标识

| 字段 | 值 | 文件 |
|------|-----|------|
| productName | `分镜大师旅游版` | `src-tauri/tauri.conf.json` |
| identifier | `com.storyboard.travel` | `src-tauri/tauri.conf.json` |
| window title | `分镜大师旅游版` | `src-tauri/tauri.conf.json` |
| package name | `storyboard-travel` | `package.json`, `src-tauri/Cargo.toml` |
| Rust lib | `storyboard_travel_lib` | `src-tauri/Cargo.toml`, `src-tauri/src/main.rs`, `src-tauri/src/lib.rs` |
| User-Agent | `Storyboard-Travel/1.0` | `src-tauri/src/commands/banana_api.rs`（约17处） |
| Vite port | `9998` | `vite.config.ts`, `tauri.conf.json:devUrl` |
| i18n title | `分镜大师旅游版` | `src/i18n/locales/zh.json`, `en.json` |

### 旅游行业预设（`src/features/project/presets.ts`）

**短视频风格（10种）**：酒店高端展示、民宿探店体验、自然风光航拍、城市打卡Vlog、美食探店打卡、文化古迹探秘、度假天堂慢生活、户外冒险极限、海滨日落浪漫、古镇漫步怀旧

**视频类型（6种）**：`TRAVEL_VIDEO_TYPES` — 酒店宣传片、探店视频、景区风光、打卡Vlog、美食探店、文化古迹

**重点维度（10种）**：航拍运镜、探店动线、光影时刻、空间流线、美食特写、地标构图、季节时令、在地文化、人气氛围、场景过渡

### Skill 文件

| 文件 | 说明 |
|------|------|
| `docs/skills/SKILL.md` | 旅游行业 Skill（300行），角色=旅游短视频策划专家 |
| `docs/skills/version.txt` | v1.0.0 |
| Skill 名称 | `xiaoya-ai-cinema-travel` |
| Skill 本地路径 | `~/.claude/skills/xiaoya-ai-cinema-travel/` |

### 旅游 Skill 核心差异

1. **15种旅游运镜**：含无人机拉升/环绕/穿越、POV步行、慢推招牌、微距特写、延时摄影等旅游专属运镜
2. **六宫格按视频类型适配**：酒店/探店/景区/打卡/美食各有一套空间递进叙事
3. **5种旅游风格模板**：高端酒店、民宿探店、航拍景区、城市打卡、美食探店（含光影/运镜/节奏/音频全参数）
4. **光影时刻强制**：户外精确到黄金时刻/蓝调时刻，室内写明灯光类型
5. **音频必填+环境音强制**：旅游视频必须写环境音（海浪/鸟鸣/风/街头人声）
6. **空间递进逻辑**："从外到内、从全景到细节"

### 视频生成规则

| 文件 | 路径 | 说明 |
|------|------|------|
| `video_gen_rules_travel.json` | `public/` | 旅游版规则 v1，含空间递进约束、旅游专属运镜、地标保护 |
| `video_gen_rules_happyhorse.json` | `public/` | 保留原版（fallback），未使用 |
| 路由 | `update.rs:24` | `travel_r2v` / `travel/travel-1.0-r2v` → `video_gen_rules_travel.json` |

**负面提示词（旅游专用）**：`chromatic aberration, motion blur excess, morphing, distortion, warping, flicker, unnatural physics, floating objects, anti-gravity, building shape drift, landmark distortion, bad weather, overcast sky, haze, construction site, trash on ground, crowded background clutter, ugly modern buildings, power lines`

---

## 构建与运行

```bash
# 安装依赖（首次）
cd D:\Story-Travel
npm install

# 开发模式
npm run tauri dev

# 类型检查
npx tsc --noEmit

# Rust 检查
cd src-tauri && cargo check

# 生产构建
npm run tauri build
# 产物：src-tauri/target/release/bundle/nsis/分镜大师旅游版_1.0.0_x64-setup.exe
```

---

## 尚未完成的 TODO

1. **服务端文件部署**：上传以下文件到 `aixiaoxi.top` 服务器

   | 本地文件 | 服务器路径 | 状态 |
   |---------|-----------|------|
   | `docs/skills/xiaoya-ai-cinema-travel.zip` | `/jy/uploads/install_guide/files/xiaoya-ai-cinema-travel.zip` | ✅ 已打包 |
   | `docs/skills/version.txt` | `/jy/uploads/install_guide/files/version_travel.txt` | ✅ 已有 |
   | `public/version_travel.json` | `/jy/uploads/app/version_travel.json` | ✅ 已创建 |
   | `public/video_gen_rules_travel.json` | `/jy/uploads/app/video_gen_rules_travel.json` | ✅ 已有 |
   | `public/grid_prompt_rules_travel.json` | `/jy/uploads/app/grid_prompt_rules_travel.json` | ✅ 已创建 |

2. **安装包图标**：`src-tauri/icons/` 目录需要替换为旅游版专用图标（当前是短视频版图标，待提供素材后替换）

---

## 共享后端关键说明

旅游版与短视频版共用同一服务器 `aixiaoxi.top`：
- **同一用户账号**：在短视频版登录后，旅游版可以复用同一 device_token，无需重新注册
- **同一积分池**：两个应用的积分消耗共享
- **同一数据存储**：`projects.db` 等数据文件基于 `identifier` 隔离（`com.storyboard.travel` vs `com.storyboard.shortvideo`），应用数据互不影响
- **不同 Skill**：旅游版下载 `xiaoya-ai-cinema-travel.zip`，短视频版下载 `xiaoya-ai-cinema-shortvideo.zip`

---

## 服务器端（需要部署的文件）

**新文件**（上传后生效，不覆盖短视频版）：

| 本地文件 | 服务器路径 |
|---------|-----------|
| Skill zip | `/jy/uploads/install_guide/files/xiaoya-ai-cinema-travel.zip` |
| 版本号 | `/jy/uploads/install_guide/files/version_travel.txt` |
| 升级检测 | `/jy/uploads/app/version_travel.json` |
| 视频规则 | `/jy/uploads/app/video_gen_rules_travel.json` |
| 宫格规则 | `/jy/uploads/app/grid_prompt_rules_travel.json` |

**共享不变**：用户认证 `/jy/api/v1/auth/*`、积分扣减 `/jy/api/v1/credits/*`、AI图像 `/jy/api/v1/ai/image`、API配置 `/jy/api/v1/api-configs/*`、模型Provider（happyhorse/gpt-image-2等）

---

## 项目目录结构（关键文件）

```
D:\Story-Travel\
├── package.json                    ← storyboard-travel v1.0.0
├── index.html                      ← 分镜大师旅游版
├── vite.config.ts                  ← port 9998
├── README.md                       ← 本文件
├── CLAUDE.md                       ← 继承自短视频版
├── src\
│   ├── features\project\
│   │   └── presets.ts              ← 旅游预设（核心定制文件）
│   ├── features\videoGeneration\
│   │   └── VideoGenDialog.tsx      ← 复用短视频版模型路由
│   ├── i18n\locales\
│   │   ├── zh.json                 ← 分镜大师旅游版
│   │   └── en.json                 ← Storyboard Travel
│   └── stores\
│       └── projectStore.ts         ← 已同步旅游版预设
├── public\
│   ├── video_gen_rules_travel.json     ← 旅游规则 v1（核心定制文件）
│   ├── grid_prompt_rules_travel.json   ← 旅游宫格规则（核心定制文件）
│   ├── version_travel.json             ← 应用升级检测
│   └── video_gen_rules_happyhorse.json ← 原版保留
├── docs\skills\
│   ├── SKILL.md                     ← 旅游 Skill v1.0.0（核心定制文件）
│   └── version.txt                  ← v1.0.0
└── src-tauri\
    ├── Cargo.toml                   ← storyboard-travel v1.0.0
    ├── tauri.conf.json              ← com.storyboard.travel / 9998
    └── src\
        ├── commands\
        │   ├── banana_api.rs        ← Skill URL 已替换
        │   ├── chat.rs              ← Skill 路径已替换
        │   └── update.rs            ← 规则路由已添加 travel_r2v
        ├── lib.rs                   ← 日志/窗口已替换
        └── main.rs                  ← crate名已替换
```
