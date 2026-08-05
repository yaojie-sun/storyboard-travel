# 分镜大师 — 行业垂直专版架构方案

## 一、现状问题

当前旅游版是通过**完整复制代码库**创建的。版本差异散落在 30+ 个文件、50+ 处修改中：

| 差异类别 | 文件数 | 修改点 |
|---------|--------|--------|
| 品牌标识（name/identifier/User-Agent/icons） | ~12 | ~40 处 |
| SKILL 名称/下载路径/安全标记 | 4 | ~22 处 |
| 行业预设（视频类型/风格/维度） | 1 | 5 个数组 |
| 视频/宫格规则文件 | 3 | 文件名路由 |
| i18n 文案 | 2 | ~10 个 key |
| 前端硬编码标签 | 7 | ~12 处 |
| Rust 日志/安装包名/上传路径 | 5 | ~10 处 |
| SKILL.md AI 行为 | 1 | 整文件 |

**结论**：每做一个新专版，需要手工翻 30+ 个文件，极易遗漏，维护成本极高。

---

## 二、目标架构

```
Story-Travel/                         ← 基础代码库（共享组件/Store/Provider/Tauri 命令）
├── editions/                         ← 专版定义目录（新增）
│   ├── travel/                       ← 旅游版
│   │   ├── edition.json              ← 单一真相源
│   │   ├── icons/                    ← 应用图标
│   │   ├── skills/
│   │   │   └── SKILL.md              ← AI 行为定义
│   │   ├── rules/
│   │   │   ├── video_gen_rules.json
│   │   │   └── grid_prompt_rules.json
│   │   └── i18n/
│   │       ├── zh.json               ← 仅版本特定 key
│   │       └── en.json
│   ├── ecommerce/                    ← 电商版（未来）
│   │   ├── edition.json
│   │   ├── icons/
│   │   ├── skills/SKILL.md
│   │   ├── rules/...
│   │   └── i18n/...
│   └── science/                      ← 科普版（未来）
│       └── ...
├── scripts/
│   └── apply-edition.mjs             ← 专版应用脚本
├── src/                              ← 共享前端代码
├── src-tauri/                        ← 共享 Rust 代码
└── public/                           ← 共享公共资源
```

---

## 三、`edition.json` — 单一配置源

所有版本差异收敛到这一个文件：

```jsonc
{
  "id": "travel",
  "version": "1.0.0",

  // ── 品牌 ──
  "brand": {
    "productName": { "zh": "分镜大师旅游版", "en": "Storyboard Travel" },
    "identifier": "com.storyboard.travel",
    "shortName": "Travel",
    "htmlTitle": "分镜大师旅游版",
    "userAgent": "Storyboard-Travel/1.0",
    "installerName": "Storyboard-Travel",
    "npmName": "storyboard-travel",
    "crateName": "storyboard_travel",
    "crateLib": "storyboard_travel_lib",
    "devPort": 9998,
    "ciWorkflow": "Build Storyboard-Travel",
    "localStoragePrefix": "storyboard-travel"
  },

  // ── Skill ──
  "skill": {
    "id": "xiaoya-ai-cinema-travel",
    "slug": "xiaoya-ai-cinema-travel",
    "directory": "xiaoya-ai-cinema-travel",
    "description": "旅游行业AI短视频制作专家",
    "rule5": "旅游写实锁死",
    "roleDescription": "旅游短视频策划专家",
    "coreCompetencies": "空间叙事、光影时刻、航拍语法、在地感"
  },

  // ── 服务端 ──
  "server": {
    "baseUrl": "https://aixiaoxi.top",
    "versionCheck": "version_travel.json",
    "gridRules": "grid_prompt_rules_travel.json",
    "videoRules": "video_gen_rules_travel.json",
    "skillVersion": "version_travel.txt",
    "skillZip": "xiaoya-ai-cinema-travel.zip",
    "uploadPath": "images/storyboard-travel",
    "modelRouteFallback": "video_gen_rules_travel.json"
  },

  // ── 行业预设 ──
  "presets": {
    "stylePresets": [
      "写实", "电影感", "极简高级", "温暖胶片", "清新明亮",
      "暗调奢华", "自然光", "黄金时刻", "蓝调时刻", "INS风",
      "度假风情", "日系治愈", "纪实人文", "航拍大景", "微距细节"
    ],
    "tonePresets": [
      "温暖", "静谧", "活力", "浪漫", "文艺", "大气", "治愈",
      "清新", "怀旧", "悠闲", "神秘", "震撼", "优雅", "野奢", "禅意"
    ],
    "videoStylePresets": [
      { "value": "hotel_luxury", "label": "酒店高端展示" },
      { "value": "bnb_explore", "label": "民宿探店体验" }
    ],
    "videoTypes": [
      { "value": "hotel", "label": "酒店宣传片", "desc": "..." },
      { "value": "explore", "label": "探店视频", "desc": "..." }
    ],
    "emphasisDimensions": [
      { "key": "drone_aerial", "label": "航拍运镜", "desc": "..." }
    ],
    "industryLabel": "旅行视频风格"
  },

  // ── i18n 覆盖 ──
  "i18nOverrides": {
    "zh": {
      "app.title": "分镜大师旅游版",
      "settings.aboutAppName": "分镜大师旅游版",
      "tokenActivation.title": "激活分镜大师旅游版",
      "chat.emptyState": "描述你的想法，小鸭分镜大师旅游版会帮你生成专业分镜提示词"
    },
    "en": {
      "app.title": "Storyboard Travel",
      "settings.aboutAppName": "Storyboard Travel"
    }
  },

  // ── 视频生成 ──
  "videoGen": {
    "fallbackPromptRule": "【铁律·旅游版】图1=视频首帧...",
    "fallbackConstraints": {
      "global_rule": "STORYBOARD = GROUND TRUTH...",
      "motion_catalog": "fixed | drone pull-up | drone orbit | POV walkthrough...",
      "hard_constraints": ["..."],
      "negative_prompt": "chromatic aberration, building shape drift..."
    }
  }
}
```

---

## 四、模板化改造

将硬编码版本值替换为模板变量，由 `apply-edition.mjs` 在构建时注入。

**模板变量命名规范**：所有模板变量以 `__EDITION__` 前缀，避免与正常代码冲突。

### 4.1 需要模板化的文件

| 文件 | 模板变量数 | 说明 |
|------|-----------|------|
| `src-tauri/tauri.conf.json` | 5 | productName, identifier, version, devUrl, title |
| `package.json` | 2 | name, version |
| `src-tauri/Cargo.toml` | 3 | name, version, description |
| `index.html` | 1 | title |
| `vite.config.ts` | 1 | port |
| `src-tauri/src/main.rs` | 1 | crate call |
| `src-tauri/src/lib.rs` | 5 | log paths, filters, messages |
| `src-tauri/src/commands/update.rs` | 8 | URLs, installer names |
| `src-tauri/src/commands/chat.rs` | 7 | SKILL paths/URLs, AI role labels |
| `src-tauri/src/commands/banana_api.rs` | 6 | User-Agent, SKILL sync paths |
| `src/features/project/presets.ts` | 1 | 整文件由 JSON 生成 |
| `src/features/videoGeneration/videoGenRules.ts` | 1 | fallback rules |
| `src/i18n/locales/zh.json` | 4 | 版本特定 key |
| `src/i18n/locales/en.json` | 4 | 版本特定 key |
| `.github/workflows/build.yml` | 2 | workflow name, RELEASE_APP_NAME |
| `src-tauri/src/ai/providers/kie/mod.rs` | 1 | UPLOAD_PATH |

### 4.2 模板文件放置

模板文件与源码同级，以 `.tmpl` 后缀区分：

```
src-tauri/
├── tauri.conf.json          ← 模板文件（含 __EDITION__ 变量）
├── tauri.conf.json.tmpl     ← 备份模板（git 跟踪）
```

> 实际开发时，`*.json` / `*.ts` / `*.rs` 文件为当前激活的专版，由 `apply-edition.mjs` 从模板生成。`.tmpl` 文件为 git 跟踪的模板源。

---

## 五、`apply-edition.mjs` — 专版应用脚本

```bash
# 切换到旅游版
node scripts/apply-edition.mjs travel

# 切换到电商版（未来）
node scripts/apply-edition.mjs ecommerce

# 创建新专版骨架
node scripts/apply-edition.mjs --create science
```

### 脚本执行流程

```
1. 读取 editions/<name>/edition.json

2. 模板替换 — 所有 .tmpl 文件中的 __EDITION__.xxx 变量替换为实际值
   - JSON 文件：直接 JSON 字段替换
   - TypeScript 文件：字符串替换
   - Rust 文件：字符串 + 符号名替换

3. 生成 presets.ts — 从 edition.json.presets 直接生成

4. 生成 i18n — 基础 zh.json + edition.json.i18nOverrides 合并

5. 复制资源：
   - editions/<name>/icons/ → src-tauri/icons/
   - editions/<name>/skills/SKILL.md → docs/skills/SKILL.md
   - editions/<name>/rules/video_gen_rules.json → public/
   - editions/<name>/rules/grid_prompt_rules.json → public/

6. 同步版本号 — edition.json.version → package.json, Cargo.toml, tauri.conf.json

7. 验证：
   - 检查无未替换的 __EDITION__ 变量
   - npx tsc --noEmit
   - cargo check
```

---

## 六、创建新专版的最小步骤

以电商版为例：

```bash
# 1. 生成骨架
node scripts/apply-edition.mjs --create ecommerce

# 2. 编辑核心配置
#    editions/ecommerce/edition.json — 品牌、预设、i18n

# 3. 编写 AI 行为
#    editions/ecommerce/skills/SKILL.md
#    角色 → 电商产品展示专家
#    六宫格 → 产品360°展示/细节/使用场景/对比/包装/CTA
#    运镜 → 微距特写/慢速推近/360°旋转/使用演示/对比镜头

# 4. 编写规则
#    editions/ecommerce/rules/video_gen_rules.json
#    负提示词 → 产品变形/颜色偏移/Logo模糊/材质失真

# 5. 放置图标
#    editions/ecommerce/icons/icon.png

# 6. 应用
node scripts/apply-edition.mjs ecommerce

# 7. 验证
npx tsc --noEmit && cargo check && npm run tauri dev
```

---

## 七、SKILL.md 的专版差异化要点

不同行业垂直版，SKILL.md 的核心差异：

| 维度 | 旅游版 | 电商版（示例） | 科普版（示例） |
|------|--------|-------------|-------------|
| AI 角色 | 旅游短视频策划专家 | 电商产品展示专家 | 科普内容导演 |
| 核心能力 | 空间叙事/光影时刻/航拍/在地感 | 产品360°/材质呈现/使用场景/对比 | 概念可视化/过程演示/数据动画 |
| 六宫格 | Hook→Context→Demo→Proof→Outcome→CTA | 外观→细节→功能→场景→对比→购买 | 问题→概念→原理→演示→应用→总结 |
| 运镜 | 无人机/POV步行/延时 | 微距/旋转台/慢推/使用演示 | 动画/图表/显微/慢动作 |
| 真实感 | 禁止CG感/塑料感/3D渲染 | 产品材质真实/Logo清晰/颜色准确 | 科学准确/数据清晰/来源可靠 |
| 音频 | 环境音强制（海浪/鸟鸣/风） | 产品音效（click/unbox/使用声）+VO | 讲解VO+实验音效+背景音乐 |
| 负面词 | 地标变形/坏天气/阴天/施工 | 产品变形/颜色偏移/Logo模糊 | 数据错误/动画不准确/来源缺失 |

---

## 八、实施优先级

| 阶段 | 内容 | 工作量 |
|------|------|--------|
| **P0** | `edition.json` 方案定稿 + `apply-edition.mjs` 脚本 | 1-2 天 |
| **P1** | 模板化改造（当前旅游版代码的 __EDITION__ 变量提取） | 1 天 |
| **P2** | 旅游版回填（将 travel edition.json 生成当前代码，零差异） | 半天 |
| **P3** | 电商版骨架 + SKILL.md + 规则文件 | 1 天 |
| **P4** | CI/CD 适配（多版构建流水线） | 1 天 |

> **最低可行方案**：先做 P0+P1+P2，让旅游版通过 `edition.json` + 模板生成。验证通过后再做 P3 电商版。
