# 跨版本移植说明 — STEP 门机 + 直出视频 + 对话文件防护 + 停靠小窗 + 单档定价 + 按条计费

> **基线版本**：小鸭分镜大师 · 短视频版（`D:\Story-ShortVideo`，分支 `aishi-dev`）
> **基线状态**：已发布至 **v1.0.79**（v1.0.78 = 门机协议 + 直出视频 + 停靠小窗 + 720P 单档定价；v1.0.79 = 升级弹窗日志限高）
> **目标版本**：服饰版 / 科普版 / 萌宠版 / 美妆版 / 大健康版 / 旅游版 等全部垂直版本
> **整理日期**：2026-10-13（第八批 + 第九批为发布后追记；第十批为美妆版复刻走偏的回灌）
> **一句话**：写手流程从「AI 自己问用户 A/B/G/X」改成「**前端持有光标 + 界面给选项卡**」，
> 并把 chat 页的「直接生成视频」做成一条完整链路。

---

## 0. 先读这一节（移植总则）

### 0.1 本次改动的三层结构

| 层 | 位置 | 职责 | 移植方式 |
|---|---|---|---|
| **A 前端** | `src/features/chat/*`、`src/stores/chatStore.ts` | 持有流程光标、渲染选项卡、把产物落成画布节点 | **原样复制** |
| **B Rust 规则块** | `src-tauri/src/commands/writer_rules/*.md` + `chat.rs` | 给写手的硬约束与形状骨架 | **原样复制**（产品语境词除外） |
| **C 产物字段** | `sceneContext` / `storySynopsis` / `characterContext` / `shotFrameMap` | §12.4 核心链路的数据契约 | 🔴 **一个字段都不许改** |

**A 层与 B 层通过字符串契约耦合，两侧必须同时改、逐字一致**：

- 锚点行 `【阶段】STEPn`（首行）—— Rust 靠首行 `【` 判断「这是控制轮」
- 模式行 `【模式】宫格` / `【模式】直出`
- 末行 `【阶段】STEP<m>`（写手回写，前端解析成下一条回复的 `stage`）

> ⚠️ **半改比不改更危险**：只移植前端不移植规则块（或反之），写手会继续输出旧的
> 「A-生成 B-不生成」话术，而前端已经没有按钮去接它 —— 用户会卡死在中间。

### 0.2 移植顺序（不可颠倒）

```
1. 复制前端新文件（§2）
2. 改前端接触点（§3.1）           ← 此时界面已就绪，但写手还在说旧话术
3. 复制 writer_rules/（§2）+ 改 chat.rs（§3.2）   ← 两侧同时生效
4. 改 SKILL.md 旧话术（§3.3）      ← 清掉残留的 L1/L2/L3
5. 改 Rust 供应商/命令（§3.4）
6. 改规则 JSON（§3.5）
7. 套第十批三件（§3.15）：视频页「删超分按钮 + 自动 2K」→ 视频定价两处对齐 → 消费清单去噪
   ⚠️ 按条计费的**服务端价目必须先上**（§3.15.3），再合客户端那 1 行
8. 跑 §5 验证清单
```

> 十一批之后的顺序都写在各自小节里；**唯一有硬时序的是 §3.15.3（服务端先、客户端后）**。

### 0.3 绝对不要动（违反 = 生产事故）

见文末 §6。

---

## 1. 本次改了什么（总览）

| 文件 | 类型 | 说明 | 移植 |
|---|---|---|---|
| `src/features/chat/stageCards.ts` | 新增 353 行 | STEP 阶段定义、锚点解析、链条推进 | **原样** |
| `src/features/chat/StageProcessLine.tsx` | 新增 98 行 | 过程阶段折叠回执（「已完成：XX」） | **原样** |
| `src/utils/gridWindowHint.ts` | 新增 241 行 | 宫格时间窗提示 +「按稿出格」锚点 | **原样** |
| `src/features/chat/shotTable.ts` | 新增 184 行 | STEP5 六列镜表 → `sceneContext`/`shotFrameMap` | **原样** |
| `src/features/canvas/nodes/VideoGenNode.tsx` | 新增 244 行 | 直出视频节点 | **原样** |
| `src/features/canvas/application/chatRefImages.ts` | 新增 45 行 | `@图N` → 资产映射（**不下移下标**） | **原样** |
| `src-tauri/src/commands/writer_rules/*.md` | 新增 5 个 | 写手规则块（见 §2.2） | **原样** |
| `public/video_gen_rules_minimax_h3_direct.json` | 新增 | 直出专用规则头 | **按版本改产品词** |
| `src/stores/chatStore.ts` | 改 +530 | 阶段光标、双路解析、选图、写盘封锁 | 见 §3.1 |
| `src/features/chat/FillGridButtons.tsx` | 重写 | STEP6 分叉（宫格 / 直出） | **原样** |
| `src/features/chat/ChatPanel.tsx` | 改 +267 | 阶段卡片、过程行、动作区 | 见 §3.1 |
| `src/features/chat/ChatBubble.tsx` | 改 +66 | 在途阶段标签 | **原样** |
| `src/features/chat/EditablePromptBlock.tsx` | 改 +4 | 选图读时兜底 | **原样** |
| `src/features/canvas/Canvas.tsx` | 改 +147 | `chat-direct-video` 监听、选图挂载规则 | 见 §3.1 |
| `src/features/canvas/domain/{canvasNodes,nodeRegistry,nodeDisplay}.ts` | 改 | 注册 `videoGenNode` 类型 | 见 §3.1 |
| `src/features/canvas/{nodes/index.ts,NodeSelectionMenu.tsx}` | 改 | 渲染注册 + `film` 图标 | 见 §3.1 |
| `src/features/canvas/ui/NodeActionToolbar.tsx` | 改 +33/-9 | 工具条去掉 `gridCellImageUrls` 打包 | **原样** |
| `src/features/videoGeneration/{videoGenRules.ts,VideoGenDialog.tsx}` | 改 | 规则按 `mode` 分键 | 见 §3.5 |
| `src/i18n/locales/{zh,en}.json` | 改 | 新增 `chat.stage.*`、`chat.stageName.*` 等 | **原样** |
| `src/stores/settingsStore.ts` | 改 1 行 | 提示词优化默认开启 | 见 §3.6 |
| `src/commands/{ai.ts,chat.ts}` | 改 | 扣费文案 2→1；新增备份命令包装 | 见 §3.6 |
| `src-tauri/src/commands/chat.rs` | 改 +223 | 规则块装配 + STEP 门机 + 护栏 | 见 §3.2 |
| `src-tauri/src/commands/update.rs` | 改 | 直出规则路由 + 去掉欢乐马分支 | 见 §3.5 |
| `src-tauri/src/commands/banana_api.rs` | 改 +87 | 供应商收敛为境内 + 新增文件备份命令 | 见 §3.4 |
| `src-tauri/src/lib.rs` | 改 | 注册 `backup_corrupt_chat_file`，注销 `integrate_video_prompt` | 见 §3.4 |
| `src-tauri/src/ai/deepseek.rs` | 改 −244 | 删除生成前二次清洗链路 | 见 §3.4 |
| `src-tauri/src/ai/providers/*` | 改/删 | 删除欢乐马供应商 | 见 §3.4 |
| `src/features/canvas/models/**/happyhorse*.ts` | **删除 3 个** | 欢乐马模型定义 | 见 §3.4 |
| `docs/skills/SKILL.md` | 改 | 六段式 + 退役 L1/L2/L3，v3.3.0 | 见 §3.3 |
| `docs/skills/version.txt` + `.zip` | 改 | 版本与打包 | 见 §3.3 |
| `src/features/chat/stageCards.ts` | 改（第二批） | **镜头覆盖制单元进度** + `【镜头范围】` 锚点 | 见 §3.7 |
| `src/stores/chatStore.ts` | 改 2 行（第二批） | 自动串链时把刚落盘的会话算成 `UnitPlan` 传下去 | 见 §3.7 |
| `src-tauri/src/commands/writer_rules/{block_critical,step_shapes}.md` | 改（第二批） | 登记 `【镜头范围】` 控制行 + STEP6 一次只出一组 | 见 §3.7 |
| `src-tauri/src/commands/chat.rs` | 改（第二批） | **空响应改成 `Err`** + 每轮打真实 `usage` | 见 §3.7 |
| `src-tauri/src/commands/chat.rs` | 改（第三批） | **技能瘦身**：官方规范原文只在出片那一步注入 | 见 §3.8 |
| `docs/skills/SKILL.md` | 改（第三批） | 官方原文加区块标记 + 删 4 块死内容，v3.4.0 | 见 §3.8 |
| `src/features/chat/stageCards.ts` | 改（第四批） | **镜头行形状兼容 / 〈分段建议〉范围写法 / 可信总数闸门** | 见 §3.9 |
| `src/features/chat/stageCards.ts` | 改（第五批） | **单元号不再自己喂自己**：判据改为「请了第 k 个单元 × 收到正文」这一对 | 见 §3.10 |
| `src/i18n/locales/{zh,en}.json` | 改（第五批） | `chat.stage.step6Done` 改口径（镜头 → 单元） | 见 §3.10 |
| `src/features/videoGeneration/dockTitle.ts` | **新增**（第六批） | 小窗副标题摘要提取（纯函数） | **原样** |
| `src/features/videoGeneration/VideoGenDock.tsx` | **新增**（第六批） | 右侧停靠小窗 + 完成提示条 | **原样** |
| `src/features/videoGeneration/VideoGenDialog.tsx` | 改（第六批） | 外层槽位表 + 内层 docked 形态（**§12.4 冻结区未动**） | 见 §3.11 |
| `src/index.css` | 改（第六批） | `video-dock-scan` + reduced-motion 回退 | **原样** |
| `src/features/videoGeneration/videoPricing.ts` | 改（第七批） | **720P 单档 · 3 积分/秒**（15 秒 = 45），`computeVideoCost` 去掉分辨率形参 | 见 §3.12 |
| `src-tauri/src/commands/banana_api.rs` | 改（第七批） | `base_credits` 只按时长；兜底改 `n * 3` | 见 §3.12 |
| `src/features/videoGeneration/VideoGenDialog.tsx` | 改（第七批） | 删掉隐藏的 1080P 选择器块 | 见 §3.12 |
| `docs/modules.md` | 改（第七批） | 定价段落同步 | **按版本改价格** |
| `src/components/UpdateAvailableDialog.tsx` | 改（第八批） | 升级弹窗日志区限高可滚（`max-h-[38vh] overflow-y-auto ui-scrollbar`） | 见 §3.13 |
| `docs/releases/v1.0.79.md` | **新增**（第八批） | v1.0.79 更新日志（单条） | 按版本写 |
| ——（运维，无代码） | 第九批 | 发布/升级链路四条硬规则 + 远端实况 | 见 §3.14 |
| `src/features/videoGeneration/VideoGenDialog.tsx` | 改（第十批） | 删三个超分按钮 + 两个确认弹窗；生成后**自动本地超分到 2K** | 见 §3.15.2 |
| `src/features/videoGeneration/videoPricing.ts` | 改（第十批） | 定价对齐基线 3 积分/秒（美妆版曾「保留自有档位」，**不要照抄那种做法**） | 见 §3.15.1 |
| `src-tauri/src/commands/banana_api.rs` | 改（第十批） | `base_credits` 同上；兜底 `other * 3` | 见 §3.15.1 |
| `src/i18n/locales/{zh,en}.json` | 改（第十批） | `videoGen.generate` → `生成视频（2K）` / `Generate Video (2K)` | 见 §3.15.2 |
| `src/stores/chatStore.ts` | 改（第十批） | 自动串链的续步带 `prompt_continue`（网关侧 0 积分） | 见 §3.15.3 |
| `src/components/ConsumptionHistoryDialog.tsx` | 改（第十批） | 用户侧清单隐藏 0 分流水 | 见 §3.15.4 |
| ——（服务端，无仓内文件） | 第十批 | 网关价目加 `prompt_continue = 0` + 运维两条 | 见 §3.15.3 / §3.15.5 |

---

## 2. 必须原样复制的文件

### 2.1 前端（6 个）

| 文件 | 职责（一句话） |
|---|---|
| `src/features/chat/stageCards.ts` | STEP0–9 的定义、`【阶段】` 锚点构造与解析、`autoNextAnchor` 自动串链 |
| `src/features/chat/StageProcessLine.tsx` | 过程阶段（STEP1/2/3/4）的折叠回执行，默认不占版面 |
| `src/utils/gridWindowHint.ts` | 认「宫格轮」并补 6 个时间窗提示；「按稿出格」锚点的产方与解方 |
| `src/features/chat/shotTable.ts` | 解析 STEP5 的六列表格 → `sceneContext[]` / `shotFrameMap` |
| `src/features/canvas/nodes/VideoGenNode.tsx` | 直出视频节点（参考图缩略图 + 提示词预览 + 打开弹窗） |
| `src/features/canvas/application/chatRefImages.ts` | 把写手选中的 `@图N` 映射到资产，**下标不许过滤** |

> ⚠️ **`shotTable.ts` 的两个常量是升级时最容易忘记的**：`COLUMN_HINTS` 里的六个英文列名
> 必须与 `writer_rules/step_shapes.md` 的 STEP5 表头**逐字一致**（`shot id & duration` 等）。
> 改了一边不改另一边 = 镜表解析静默失败（fail open，表现为「这一轮少了场景锚点」）。

### 2.2 Rust 规则块（5 个）

放到 `src-tauri/src/commands/writer_rules/`：

| 文件 | 内容 | 注入条件 |
|---|---|---|
| `block_critical.md` | 路由表（首行判据 → 走哪条） | **恒注入**，且必须排在其余块**之前** |
| `block_constraints.md` | 通用约束 + 输出契约 + 内容铁律 | 恒注入 |
| `block_mapping.md` | `【分镜映射】` JSON 铁律 | 恒注入 |
| `step_shapes.md` | STEP0–9 每一步的产物形状 | **只在锚点轮**（首行 `【`） |
| `stall_guard.md` | 「别停」护栏 | **只在非锚点轮**（与上一条互斥） |

> 🔴 **`include_str!` 不需要在 `commands/mod.rs` 声明模块** —— 它是编译期读文件，
> 路径相对 `chat.rs` 所在目录。移植时照抄即可。

> ⚠️ **这些 .md 文件开头的空行与结尾的无换行是有意的**（拼接时的分隔符），
> 别顺手「格式化」。

### 2.3 i18n key（新版）

两台语言包都要加（`zh.json` / `en.json`，**不许缺语言键**）：

```
chat.stage.*          step0 / confirm / step55 / grid / direct / rerun / step6 / step6Done /
                      nextUnit（含 {{unit}} 与 {{shots}} 两个插值）/ done /
                      continue / next / directNow
chat.stageName.*      step0…step9 / step55 / stageDone / writing / writingPlain
chat.generateStoryboard
chat.storageWarningBackedUp      （含 {{path}} 插值）
chat.storageWarningWriteBlocked
common.dismiss
node.menu.videoGen
node.videoGen.*
```

> ⚠️ **带动态值的选项必须走 `StageCardOption.labelVars`，不要把变量拼进 `label`** ——
> `label` 只是「资源串缺失时的兜底」，中英双语走的是 `labelKey`。拼在 `label` 里的话
> 英文用户看到的是 `Next unit ({{unit}})` 这种半成品。

> ⚠️ 各垂直版本的**产品语境词**（如「生成宫格图」是否要写成「生成服装宫格图」）
> 在这里统一改；不要改到组件里去。

---

## 3. 需要接触点改动的文件

### 3.1 前端接线

#### `src/stores/chatStore.ts`（**最高风险文件，改动必须逐条核对**）

| 改动 | 说明 |
|---|---|
| 新增导入 | `stageCards` 的 `parseStageAnchor`/`autoNextAnchor`、`gridWindowHint` 的 `enrichGridRequest`、`shotTable`、`projectContext`、`episodeStore`、`gridPromptParser` |
| `ChatMessage.stage?: string` | **optional** ⇒ 老会话渲染与改动前完全一致 |
| `streamingStage` / `autoChain` / `autoChainMode` | 前端持有的**流程光标** |
| `sendMessage(content, billingTag?, opts?: {auto?})` | 第三个参数区分「用户点」与「自动串链」 |
| 自动串链 | 回复落库后，若 `autoChain && askedStage`，`setTimeout(0)` 发 `autoNextAnchor(...)`；`AUTO_CHAIN_TERMINUS = 'STEP6'` 处停 |
| 宫格轮富化 | 发请求前对最后一条 user 消息跑 `enrichGridRequest(...)`（**只改送出去的那一份**，不写回消息） |
| 回复处理 | `stripStageAnchorLine` 剥离末行锚点 → `displayedText`；`attachStageContext` 回填 `storySynopsis`/`characterContext`/`sceneContext`/`shotFrameMap` |
| `parsePromptBlocks` 双路 | 命中官方六段式 → 新分支；否则 → legacy 分支（**必须保留，旧对话靠它**） |
| 选图三级取值 | `【选图】@图N` → 正文 `<Picture N>` → 继承上一条带选图的 assistant 消息 |
| **写盘封锁**（见 §3.1.1） | `chatFileWriteBlocked` + `safeParseConversations` + `markChatFileCorrupt` |

#### `src/features/canvas/Canvas.tsx`

| 改动 | 说明 |
|---|---|
| `chat-direct-video` 监听器 | 建 upload 节点（≤6，`centerY + 220` 一字排开）+ 一个 `videoGen` 节点 + 连线；`saveConfig` 预置提示词/画幅/时长/参考图；`canvasEventBus.publish('video-gen-dialog/open', …)`。**不提交任务 = 不扣费** |
| 选图挂载规则 | 改为**以写手为准**：删掉「无【选图】→ 回退最近 N 张」分支，改用 `matchRefAssets`；无选图时 `console.warn` 且**一张都不挂** |

> 🔴 **必须落一个真实的 `videoGenNode`**：`VideoGenDialog` 的全部持久化都被
> `if (nodeIdRef.current)` 包住 —— `nodeId` 为空时视频能生成但**静默不落盘**（违反 §12.4）。

#### 节点注册（CLAUDE.md §4.5 / §8.3 清单，四处都要改）

| 文件 | 改动 |
|---|---|
| `domain/canvasNodes.ts` | `CANVAS_NODE_TYPES.videoGen = 'videoGenNode'`；`VideoGenNodeData`；入 `CanvasNodeData` 联合；`isVideoGenNode` 守卫 |
| `domain/nodeRegistry.ts` | `videoGenNodeDefinition`：`visibleInMenu`、`capabilities`、`connectivity`。⚠️ **`targetHandle` 必须为 `true`**，否则 `addEdge` 静默返回 `null`、上传图连不上 |
| `domain/nodeDisplay.ts` | `DEFAULT_NODE_DISPLAY_NAME` 加 `videoGenNode: '直出视频'` |
| `nodes/index.ts` + `NodeSelectionMenu.tsx` | 渲染注册 + `iconMap` 加 `film` 图标（联合类型改了 `Record` 不同步会 TS 报错） |

#### `src/features/chat/ChatPanel.tsx` / `FillGridButtons.tsx` / `ChatBubble.tsx`

- 跳过 `isStageAnchorMessage` 的 user 消息（锚点不显示成气泡）
- `isProcessStage(msg.stage)` → 渲染 `StageProcessLine`，不渲染动作区
- 动作区（**气泡外**）：`FillGridButtons` + 阶段卡片选项
- `FillGridButtons` 自身承担**宫格 / 直出两个按钮**（原 `DirectVideoButton.tsx` 已并入，
  移植时**不要再单独建一个文件**）
- 流式气泡接 `stage={streamingStage}`，优先显示「正在写：〈步骤名〉（n/8）」

#### `src/features/canvas/ui/NodeActionToolbar.tsx`

去掉工具条上把 `gridCellImageUrls`（切好的单格图）一起喂给视频生成的逻辑 —— 现在**整张拼合图直接喂**。

### 3.2 `src-tauri/src/commands/chat.rs`

把原来**内联写在函数里**的三段 `push_str` 换成 `include_str!` 常量，并新增门机/护栏：

```rust
// 常量（文件顶部）
const BLOCK_CONSTRAINTS: &str = include_str!("writer_rules/block_constraints.md");
const BLOCK_MAPPING:     &str = include_str!("writer_rules/block_mapping.md");
const BLOCK_CRITICAL:    &str = include_str!("writer_rules/block_critical.md");
const STEP_SHAPES:       &str = include_str!("writer_rules/step_shapes.md");
const STALL_GUARD:       &str = include_str!("writer_rules/stall_guard.md");

// 函数（文件顶部）
fn needs_stall_guard(user_msg: &str) -> bool {
    if user_msg.is_empty() { return false; }
    let first_line = user_msg.lines().next().unwrap_or("").trim();
    if first_line.starts_with('【') || first_line.starts_with("暂停") { return false; }
    true
}
```

装配次序（**承重，不是排版**）：

```rust
system_prompt = SKILL.md
              + 【项目全局上下文】
              + BLOCK_CRITICAL     // 🔴 路由表必须排在约束之前
              + BLOCK_CONSTRAINTS
              + BLOCK_MAPPING
              + (锚点轮) STEP_SHAPES
              + (非锚点轮) STALL_GUARD   // 🔴 紧贴 user 消息，位置是杠杆
```

🔴 **次序是实测结论**（同一输入、同一份 system 前缀、块体积逐字节相同，只换次序）：
路由表排在**末尾**时退化 12/12，排在**最前**时 0/12。它紧贴 user 消息时，模型去做
**路由判断**而不是**写提示词**，于是把启动欢迎语原样吐回来。动这几行之前先看这段。

🔴 **旧词表必须整体删掉，不能留着当保险**：新协议下 `A` 不再是控制词，
留着它反而会把「用户真的写了一句话脚本以 A 开头」那一轮漏掉护栏。**半改比不改更危险。**

#### 3.1.1 对话文件写坏防护（配套，建议一起移植）

| 文件 | 改动 |
|---|---|
| `src-tauri/src/commands/chat.rs` | 新增 `backup_corrupt_chat_file` 命令（**只复制、不动原文件**，返回 `.corrupt-<ts>` 路径） |
| `src-tauri/src/lib.rs` | 注册 `chat::backup_corrupt_chat_file` |
| `src/commands/chat.ts` | `backupCorruptChatFile(projectId)` 包装 |
| `src/stores/chatStore.ts` | `safeParseConversations` 返回 `{ list, corrupt }`；`markChatFileCorrupt` 先备份再告警；**备份失败 ⇒ `chatFileWriteBlocked = true`，三个写盘点（localStorage / 定时落盘 / 防抖调度）全部 return** |
| `hydrate` 根因护栏 | `const pid = projectId \|\| get().currentProjectId \|\| ''`，**没有 pid 直接 return，绝不能把 `hydrated` 烧成 true** |
| `ChatPanel.tsx` | 琥珀色警示条 + `common.dismiss` |

> **为什么必须先备份**：解析失败会回退成空列表，而 5 秒定时器的下一次整量存盘
> 会把坏文件覆盖成 `[]` —— 用户的历史对话**永久消失**。这是 §12.4 级的事故。

### 3.3 `docs/skills/SKILL.md` + `version.txt` + `zip`

**要改的三处**（本次已改完，移植时照做）：

1. **强制规则2** —— 从「每段提示词后必须询问宫格（A-生成 B-不生成）」改成
   「宫格/直出的分叉**由界面给**，禁止在末尾追加分步确认问句；唯一允许的收尾是
   末行独占一行写 `【阶段】STEP<m>`」。
2. **第二条第 7 项 + 拆分确认对话** —— 删掉 `📐 您的内容预计需要…回复 G` 与 `G/X` 话术，
   改成「按 `【单元】Uk` 逐单元出片，界面负责推进」。
3. **第七步 / 终点规则 / 第八步末尾** —— 删掉 L2 宫格询问、L3 `【继续确认】`、
   `继续-生成下一段 / 暂停-先处理当前内容` 全套话术，改成「宫格与直出**都是 `【阶段】STEP6`**，
   只差 `【模式】` 一行」。

> 🔴 **注意「禁止句」要留**：文档里**必须保留**「禁止输出 A-生成 / B-不生成 / 继续-生成下一段
> 这类分步确认问句」这句**否定式**描述 —— 全文搜到这几个词是**正常的**，那是禁令不是残留。
> 判断清理干净的方法是：搜到的每一处上下文都带「禁止 / 不要 / 不再输出」。

**收尾两件事**：

```bash
# ① version.txt：版本+1（本次 3.2.0 → 3.3.0），changelog 加一条
# 🔴 changelog 禁止出现模型名（MiniMax / H3 / 海螺 / 欢乐马 / 优云智算 / compshare / wan）
# ② SKILL.md 第 10 行的 SECURITY_MARKER 与 version.txt 对齐（本次 → v3.3.0）
```

**重新打包**（Git Bash 下没有 `zip` 命令，用 Python；`arcname` 平铺，不带目录前缀）：

```bash
python -I -c "
import zipfile, os
base = r'<repo>/docs/skills'
out = os.path.join(base, 'xiaoya-ai-cinema-shortvideo.zip')
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for n in ('SKILL.md', 'version.txt'):
        z.write(os.path.join(base, n), arcname=n)
print('rebuilt')
"
```

### 3.4 Rust 供应商与命令收口

| 文件 | 改动 |
|---|---|
| `ai/providers/happyhorse/mod.rs` | **删除**（整个 provider） |
| `ai/providers/mod.rs` | 去掉 `pub mod happyhorse;` |
| `ai/deepseek.rs` | **删除生成前的提示词二次清洗/集成链路**（−244 行）。本次起，成片用的就是用户看到的那一份，中间不再过一遍模型 |
| `ai/providers/minimax/mod.rs` | 适配 compshare 直连（+145） |
| `commands/banana_api.rs` | ① 密钥槽位 `happyhorse_video` → `compshare_video`（**多别名匹配**：`compshare_video` / `COMPSHARE_VIDEO` / `minimax_h3` / `minimax_video` / `compshare` …，避免服务端字符串不一致导致密钥为空）；② 默认模型从 `happyhorse/…` → `minimax/minimax-h3`；③ **把「密钥解析」提到「扣费」之前**（密钥缺失属配置问题，不应先扣后退）；④ 不支持模型的报错文案同步 |
| `lib.rs` | 注册 `backup_corrupt_chat_file`；注销 `integrate_video_prompt` |
| `commands/chat.ts` | 删除 `cleanVideoPrompt` 包装 |

> ⚠️ **第 ③ 条虽然只是顺序调换，但落在 §12.2 的计费链路上**：`banana_consume_credit`
> 的调用本身**没有变**，只是不再出现「扣费成功但密钥缺失」的窗口。移植后请按 §5 复核一次。

### 3.5 规则文件按 `mode` 分键

| 文件 | 改动 |
|---|---|
| `src-tauri/src/commands/update.rs` | `resolve_video_gen_rules_url(model, mode)`；`mode == "direct"` → `video_gen_rules_minimax_h3_direct.json`；去掉欢乐马分支；Tauri 命令加 `mode: Option<String>` |
| `src/features/videoGeneration/videoGenRules.ts` | `fetchVideoGenRules(model, mode)`；**缓存键改为 `${model||'default'}\|${mode}`**（原先全局单值，切模型会串规则）；`DEFAULT_RULES`/`DEFAULT_PROMPT_RULE` 兜底同步 |
| `src/features/videoGeneration/VideoGenDialog.tsx` | `mode` 由**节点类型推导**：`clickedNode?.type === 'videoGenNode' ? 'direct' : 'grid'`，随 payload 传进 Inner（**不需要 UI 传参**）；legacy 分支的硬编码模型名改成 `videoModel` |
| `public/video_gen_rules_minimax_h3_direct.json` | 新增：直出规则头（参考图是独立资产、无 6 格时间线） |
| `public/video_gen_rules_minimax_h3.json` | `prompt_rule` / `constraints` 改成六段式自洽版本，`version` 递增 |

### 3.6 两个小改动

| 文件 | 改动 | 说明 |
|---|---|---|
| `src/stores/settingsStore.ts` | `deepseekPromptOptimization: false` → `true` | 提示词优化默认开启 |
| `src/commands/ai.ts` | 扣费文案 `x2` → `x1` | ⚠️ **只改了文案与注释，实际扣费额度没动**。若产品上确实要改额度，必须同时改 `banana_consume_credit` 的 `count`，**且这属于 §12.2 计费链路，需单独审批** |

### 3.7 第二批：多单元续写（「出下一单元」）+ 空响应不再当成功

**背景（用户实测上报）**：一条 9 个镜头的脚本，自动串链跑到 `STEP6` 出了第一单元的正片提示词，
**然后就没有然后了** —— 用户原话「要我生成下一段，但是下一段也没提示我生成」。

**两个独立的成因，各自修掉**：

#### ① 门机切换时把「继续生成下一段」这个能力一起删掉了（能力缺口）

| 文件 | 改动 |
|---|---|
| `src/features/chat/stageCards.ts` | `UnitPlan` 重写成**镜头覆盖制**；`step6Card(unit)` 动态给「出下一单元（U2 · Shot 4 - Shot 6）」；`autoNextAnchor` 加第三个形参 `unit` |
| `src/stores/chatStore.ts` | 自动串链那两行：`autoNextAnchor(askedStage, mode, resolveUnitPlan(updatedMessages))` —— 传 `updatedMessages` 而**不是** `get().conversations`（后者还没包含刚落盘的这条回复） |
| `writer_rules/block_critical.md` | 控制行清单加 `【镜头范围】Shot 4 - Shot 6` |
| `writer_rules/step_shapes.md` | 适用条件加该行；STEP6「出片提示词」加「一次只出一组 + 不重出 + 出完就停」 |
| `i18n` | `chat.stage.nextUnit` 改成 `出下一单元（{{unit}} · {{shots}}）` / `Next unit ({{unit}} · {{shots}})`；新增 `chat.stage.step6Done` |

🔴 **移植时最容易搬错的是判据，不是 UI**。这里**返过工**，务必照抄结论：

| 判据 | 结果 |
|---|---|
| ❌ 按镜头表里的 `U(\d+)` 记号算单元总数 | **废**。用户第一条真实会话（9 镜头 / 34 秒）**整张表一个 `U` 记号都没有**（`step_shapes.md` 的 STEP5 形状里**没有**要求〈分段建议〉）⇒ 恒不出按钮 |
| ✅ 按 **`[Shot N]` 覆盖**算 | `totalShots` ← 镜头表（`共 N 个镜头` / `[Shot N]` / 行首 `S03（3.0s）`）；`covered` ← 所有含 `subject_definitions:` 的出片正文里的 `[Shot N]` 并集；下一个单元 = **第一个没覆盖到的镜头**所在的那一组 |

⚠️ **这个判据本身又返过一次工**（第三批之后实测复现：3 个单元的脚本出完第一段后**还是没有按钮**）
—— 镜头表**行形状**还有第五种没认、〈分段建议〉还有第二种写法没认，且缺一道「可信总数」闸门。
**移植时务必按 §3.9 补齐**，只搬 §3.7 的表会复现同一个 bug。

分组来源按优先级：①镜头表末尾的〈分段建议〉（写手自己划的，最权威）；
②按秒数贪心切单元（`UNIT_MAX_SECONDS = 15`，依据 `SKILL.md`「单段视频最长 15 秒」）；
③读不出秒数时每 3 个镜头一组（`UNIT_FALLBACK_SHOTS`）。

**附带好处（也是选这个判据的理由）**：不会重出已经出过的镜头；写手一次把全部镜头出完 ⇒
`finished: true` ⇒ 不给按钮、问题行换成「全片镜头都出过了」。

⚠️ **`【镜头范围】` 必须在自动串链那一跳就带上**（`autoNextAnchor` 的 `unit` 形参就是干这个的）：
第一单元由写手划、后面的单元由 `step6Card` 按同一套分组续 —— 两边不同源就会
「U1 出了镜头 1-3，按钮却说下一个单元是 Shot 4-6」这种对不上的账。
读不出镜头表时照旧只发 `【单元】U1`，写手按镜头表自取（fail-open，与改动前逐字一致）。

#### ② 网关返回 HTTP 200 + 空正文，被当成「成功」

| 文件 | 改动 |
|---|---|
| `src-tauri/src/commands/chat.rs` | `if text.is_empty()` 从「`warn!` + `Ok(...)`」改成 **`Err(...)`**，并把 `stop_reason` / `usage` / 原始响应前 1200 字符打进日志；**每轮**（不只是空响应）都打一行 `[Chat] 响应完成 chat_id=… len=… usage=…` |

原行为的三重伤害：前端把它当正常回复落盘（`stage` 照记）⇒ 自动串链在终点停住、界面上
**一个字都没有**；日志里也**没有任何线索**（上游只回思考内容 / `finish_reason=length` 把
`max_tokens` 全吃在思考上 / 上游内容过滤 —— 三者在客户端长得一模一样）。

⚠️ **`CHAT_MAX_TOKENS` 保持 8192 没动**：调大有触发供应商 400 的风险，那会**炸掉全部对话**。
要先拿到真实 `usage` 再决定，不要顺手改。

用 `usage=` 那行可以**实测**每一轮的真实 token（这是「生成一段提示词到底花多少 token」的唯一可靠口径），
别再用估数（服务器 `estimate_tokens` 是中文×2，比 DeepSeek 自己的口径**高估约 1.9 倍**）。

---

### 3.8 第三批：技能瘦身（官方原文按步注入）—— 成本

**背景**：自动串链**出一段提示词 = 8 次网关调用**，每次都要重发整份 system（含 `SKILL.md`，
7 万余字）⇒ SKILL 体积是成本的唯一主因。而 8 步里**只有出片那一步（STEP6）**真的在写
送模型的提示词正文；Step 0–5.5 写的是需求复述/项目简报/故事大纲/角色清单/场景清单/镜头表/自检。

**做法（一个字的原文都不删）**：把 `SKILL.md` 里的**官方写作规范原文**用一个区块标记圈起来，
运行时**只在 `【阶段】STEP6` 那一轮注入它**。

| 文件 | 改动 |
|---|---|
| `docs/skills/SKILL.md` | 官方原文区用 `<!-- OFFICIAL_SPEC_BEGIN … -->` / `<!-- OFFICIAL_SPEC_END … -->` 圈起（本仓在 **L31 / L634**，内含三篇官方文档）；`SECURITY_MARKER` 与 `version.txt` 一起升到 **3.4.0** |
| `docs/skills/version.txt` | 版本递增 + changelog（🔴 **changelog 禁止出现模型名**） |
| `src-tauri/src/commands/chat.rs` | 新增 `parse_anchor_stage` / `strip_official_spec`；在 `ensure_skill_md()` 之后、拼规则块之前做分流；顺带把 `last_user_msg` / `anchor_turn` **提前到函数开头**算一次 |

```rust
// 白名单：只有「确定不写六段式正文」的步骤才剥
const NO_SPEC_STAGES: &[&str] =
    &["STEP0", "STEP1", "STEP2", "STEP3", "STEP4", "STEP5", "STEP5.5"];

let strip_official = anchor_stage
    .as_deref()
    .map_or(false, |s| NO_SPEC_STAGES.contains(&s));   // 表外一律 false ⇒ 全量注入

if strip_official {
    system_prompt = strip_official_spec(&system_prompt);
}
```

**四条不能省的约束**：

1. 🔴 **用白名单，不要写「不是 STEP6 就剥」**（本仓这里返过一次工）。
   白名单漏一个步骤 ⇒ 只是多花点 token；黑名单漏一个 ⇒ 把**出片那一轮**的规范依据切掉，
   产出格式会莫名其妙地崩，而日志里只有一行「已省略」看不出来。
   ⇒ 表外含 STEP6、STEP7/9，以及**任何将来新增或写错的步骤名**，一律全量注入。
2. 🔴 **fail-open**：`anchor_stage` 解析不出来（用户手打 / 老会话 / 形状不合）、
   或 `SKILL.md` 里找不到标记（本地缓存的是旧包）⇒ **原样返回全量**。
3. 🔴 **步骤名字面量两侧必须一致**：来自前端 `stageCards.ts` 的锚点契约
   （CLAUDE.md §12.3），改一侧必须同改另一侧。
4. ⚠️ **非锚点轮不瘦身**：每个会话第一条消息（STEP0 入料）同时是「用户随手贴一句话」的兜底路径，
   一律全量。⇒ 一个单元 8 次调用里实际省 6 次。

**实测**（`SKILL.md` 剥离前 71,252 字符）：标记区间 **41,390 字符**，剥离后 **29,862 字符（−58%）**。

🔴 **但要按 token 口径报账，不要按字符口径**（这里返过一次工）：同一份 SKILL、同样的对话历史，
逐轮对比同一步骤的 `usage.input_tokens`，实测**每轮只省 ≈7.7k~9.4k 输入 token**（≈ −8.5k 均值），
**不是**字符口径暗示的 −43%。原因是那段区间几乎全是英文（≈4.6 字符/token），
而服务器 `estimate_tokens`（中文×2）把它算得远大于真实值 —— 两个口径差 1.9 倍。

| 一整条链（8 次调用） | 输入 token |
|---|---|
| 瘦身前（全量注入） | **287,648** |
| 瘦身后（6 轮剥离 + STEP6/首轮全量） | **227,048** |
| 差 | **−60,600（−21%）** |

折算：¥1.1–2.2/M ⇒ 每个单元省 **¥0.07–0.13**（1 积分 = ¥0.067）。
⚠️ 省的是**我们付给上游的钱**；用户扣点由服务器定价决定，**不改**（CLAUDE.md §12.2）。

日志两条口径（对着日志就能确认「该省的省了、该给的给了」）：

```
[Chat] 技能瘦身：本轮 stage=STEP3 ⇒ 官方规范原文已省略（71252 → 29862 字符）   ← 白名单步骤
[Chat] 技能瘦身：本轮 stage=STEP6 ⇒ 官方规范原文**全量注入**                  ← 出片轮 / 未知步骤
```

剥前后长度相同时追加一条 warn（说明这轮**没省成**，本地技能是旧包）。

**逐条核过「少了官方原文会不会写坏」**：STEP5 要的六列表头**逐字写在**
`writer_rules/step_shapes.md`（锚点轮必注入）；STEP5.5 是**镜头表**自检而不是提示词格式自检；
STEP7/9 是模型分辨率与复查报告。区间**外**照旧全量注入的：`SKILL.md` 开头的「分路声明」
（告诉我们走全参考路）、六条强制规则、〈产品接线〉、运镜参考、七条硬规则、六段式示例、
宫格指南、经验规则。

**本仓同时删掉的死内容（949 tok，纯降本）**：`## 🚀 启动时`、
工作流程·第七步「宫格/直出分叉」（与运行时块逐字重复）、`## 平台参数说明`、`## 自动学习机制`。
⚠️ **第一/二步、第四步不要删** —— 它们是**唯一一份**动作密度铁律 / 运镜闭集 / 人脸光影铁律 /
违禁场景词表（含规避方法）。完整口径见 `docs/skills/SKILL-trim-plan.md`。

---

### 3.9 第四批：镜头行形状兼容 + 〈分段建议〉范围写法 + 可信总数闸门

**背景（用户实测上报，§3.7 修完仍然复现）**：「# 分段方案｜《专访孙二娘》45 秒（3 单元 × 15 秒），
SKILL 分析出需要 3 段，但是第一段生成后，就没有第二段的提示按钮了」。

**根因**：写手这一次的镜头表换了形状，`stageCards.ts` 三条正则**一条都没匹配上**：

| 写手实际写的 | 旧正则 | 结果 |
|---|---|---|
| `\| **Shot 1**（U1·全片 00:00.000–00:04.000）｜4s \| …` | 只认 `[Shot N]` 与行首 `S03（` | **一行都没认出来 ⇒ `rows = 0`** |
| 表上方没有 `共 N 个镜头` 那句 | `SHOT_TOTAL_RE` 找不到 | `declaredTotal = 0` |
| `- **【单元】U1 = Shot 1 – Shot 3**（全片 00:00.000–00:15.000，15 秒）｜…` | 只认 `- **U2**：[Shot 3] + [Shot 4]` | 〈分段建议〉也没认出来 |

⇒ `totalShots` 只能退化到「已覆盖的最大镜号 = 3」⇒ 第一单元（Shot 1-3）出完即判 `finished`
⇒ 弹「全片镜头都出过了」且**不给按钮**。**连锁伤害**：用户只能手打「生成下一段」，
而手打消息不是锚点 ⇒ `askedStage` 落 `STEP0` 入料 ⇒ 整条链从 `STEP1` 重跑
（**8 次调用、≈29 万输入 token 白花**）并**重出了第一单元**。

| 文件 | 改动 |
|---|---|
| `src/features/chat/stageCards.ts` | ①`SHOT_ROW_RE` → `matchShotRowHead(line)`：**只取表格首格**再认 `[Shot N]` / `Shot N` / `S03（`；②新增 `collectShotNumbersLoose`：认范围写法（`- – — ~ 至`）并展开成逐个镜号；③`DECLARED_UNIT_INLINE_RE` 认 `【单元】U2 = …`，旧的 `DECLARED_UNIT_LEGACY_RE` 保留；④`resolveUnitPlan` 加**可信总数闸门** |

```ts
// ① 只认首格：第二格起会写「承接 Shot 2 的结尾」这类正文
function matchShotRowHead(line: string): number | null {
  const trimmed = line.trimStart();
  const head = trimmed.startsWith('|') ? (trimmed.split('|')[1] ?? trimmed) : line;
  const m = head.match(/\[Shot\s*(\d+)\]|Shot\s*(\d+)|S(\d+)\s*[（(]/);
  ...
}

// ④ 可信总数只认镜头表里读得出来的三种来源，**不含「已覆盖的最大镜号」**
const trustedTotal = Math.max(
  rows.length > 0 ? Math.max(...rows.map((r) => r.n)) : 0,   // 表格行
  Number.isFinite(declaredTotal) ? declaredTotal : 0,        // 共 N 个镜头
  declaredUnits ? Math.max(...declaredUnits.flat()) : 0,     // 〈分段建议〉
);
if (trustedTotal <= 0) return null;   // 读不出总数 ⇒ **没有按钮**，绝不判「全片出完了」
```

**四条移植约束**：

1. 🔴 **`【单元】` 记号必须留在正则里**：镜头表自己的行里也写着 `（U1·全片 …）`，
   把〈分段建议〉的正则放宽成裸 `U(\d+)` 会把**镜头行**当成单元声明，算出 `U1 = [1]` 这种垃圾分组。
   ⇒ 同时**跳过表格行**（除非该行明写 `【单元】`）。
2. 🔴 **绝不拿「已覆盖的最大镜号」当总数**。宁可返回 `null`（没有按钮，fail-open 到改动前的老样子），
   也不能判 `finished: true` —— 前者用户点一下重发就能恢复，后者会**骗用户说全片出完了**，
   并把用户逼到手打重跑整条链。
3. ⚠️ **秒数读取位**：`SHOT_SECONDS_RE` 在 `line.slice(0, 120)` 上取第一个 `\d+s`；
   新行形状里 `｜4s` 排在 `（U1·全片 00:00.000–00:04.000）` **之后**、第二格正文之前，
   所以取到的仍是本镜时长（`00:04.000` 里没有 `s`）。改行形状时**要重验这一条**。
4. ⚠️ **表头不能误判成镜头行**：`| Shot ID & Duration | …` 靠「`Shot` 后面必须跟数字」排除；
   `matchShotRowHead` 里的 `Shot\s*(\d+)` 分支别改成宽松的 `Shot`。

**回归验证（`docs/port-step-gate-direct-video.md` §5.2 之外单列）**：拿**真实会话文件**
`app_data_dir/users/{id}/chat/*.json` 跑一次纯函数探针（`resolveUnitPlan` 无 IO、无 store 依赖，
esbuild 打成 cjs 直接跑）。⚠️ **本节的断言已被 §3.10 改掉**，以 §3.10 为准。

⚠️ **未做的相邻问题（移植时按需一并处理）**：手动发一句话（如「生成下一段」）现在**仍然**会把
`askedStage` 落 `STEP0` 并**重跑整条链**（`chatStore.ts` 里有明确设计注释：「用户手动发的消息 = 重新开串联」）。
按钮修好后这条路径已不是唯一出路，故本次**未动**；若要加「手打『继续』= 发 STEP6 下一单元锚点」
的兜底，属于**行为变更**，需单独确认。

---

### 3.10 第五批：单元号失控（`U5 · Shot 4 - Shot 5`）—— 我们自己发的锚点被读回来当计数

**症状（用户实测）**：卡片显示「出下一单元（**U5** · Shot 4 - Shot 5）」，写手回
「本片共 3 个生成单元，**不存在 U4**」。即**编号与镜头范围自相矛盾**：范围（= U2）是对的、
编号（U5）是错的，且写手被一个不存在的单元号问住、白跑一轮。

**这是两个独立的坑，只修一个不够。移植时两个都要修。**

#### 坑一：拿「我们发过的锚点」当计数 ⇒ 每轮 +1 的无上限逃逸

我们发出去的锚点**本身就是用户消息**（`isStageAnchorMessage` = 首行 `【阶段】`），
而锚点里的 `【单元】Uk` 正是上一轮由 `next` 算出来的 ⇒ 读回来再 +1：

```
explicitUnit_{k+1} = next_k                // 读回来的
next_{k+1} = max(next_k, produced) + 1 ≥ next_k + 1     // 每轮必 +1，无上限
```

实测轨迹 U3 → 发【单元】U3 → 读回 3 → next=4 → 发 U4 → next=5 …
**它永远不会自己停下来**，与镜头覆盖多少无关。⇒ **禁止**用 `UNIT_WRITE_RE` 那套扫用户锚点计数。

#### 坑二：正文里的 `[Shot N]` 是**单元内部局部编号** ⇒ 覆盖永远推进不了

六段式契约里，**一个单元 = 一个独立可出片的提示词**，所以写手的 `[Shot N]` 从 **1** 开始、
时间戳从 **0** 开始，**不接全片镜号**。实测：同一个 8 镜脚本，三个单元的正文分别是
`[1,2,3]` / `[1,2]` / `[1,2,3]` —— 第二个单元起就与全片镜号彻底对不上。

⇒ 任何「按全局镜号算覆盖」的进度判据（`covered` / `uncovered` / `groups.every(n => covered.has(n))`）
**从第二个单元起永远不成立** ⇒ 范围卡死在第一个未覆盖的镜号上（实测「Shot 4 - Shot 5」永远不变），
且永远到不了 `finished`。**这条同样是给「已出过几个单元」计数时的坑，别再用正文镜号。**

#### 正确判据（第三版）：**「我们请了第 k 个单元」×「真收到了一份出片正文」这一对**

```ts
const produced = new Set<number>();
let pendingUnit: number | null = null;
for (const msg of scope) {
  if (msg.role === 'user') {
    // 每条用户消息都**重设**待兑现的号：锚点=它要的号；非锚点=清空
    // （免得一条早先失败的锚点被后面无关的正文兑现）
    pendingUnit = isStageAnchorMessage(msg.content) ? requestedUnitOf(msg.content) : null;
    continue;
  }
  if (msg.role !== 'assistant' || msg.stage !== 'STEP6') continue;
  if (!looksLikeShotPrompt(msg.content)) continue;   // 空响应 / ⚠️ 中断占位都不含 subject_definitions:
  if (pendingUnit !== null) produced.add(pendingUnit);
  pendingUnit = null;                                 // 一个锚点只兑现一条正文
}

let next = 1;
while (produced.has(next)) next += 1;                 // = 第一个还没产出的单元号
const done = Math.min(produced.size, groups.length);
if (next > groups.length) return { ..., nextShots: '', finished: true };
return { ..., next, nextShots: formatShotRange(groups[next - 1]) };  // 🔴 与 next 同源
```

`requestedUnitOf(content)`：**不是 `STEP6` 的锚点 ⇒ `null`**（不参与兑现）；
`STEP6` 锚点取 `【单元】U?(\d+)`，取不到（老锚点 / 自动串联的第一单元不带单元行）⇒ **1**。

**四条移植约束**：

1. 🔴 **`next` 必须是「第一个没产出的号」，不是「见过的最大号 + 1」**。前者单调、有界、
   可自愈（重复出同一单元不跳号）；后者每轮 +1、无上限。
2. 🔴 **编号与范围必须同源**：`nextShots = groups[next - 1]`，`next` = 该分组下标 + 1。
   两处各自算就会重新长出「U5 · Shot 4 - Shot 5」这种一行内自相矛盾的卡片。
3. 🔴 **正文判据只认 `subject_definitions:`**（六段契约第一段）。空响应与
   `⚠️ AI 回复中断（App 在生成期间关闭）` 占位都不含它 ⇒ 不会把失败的一轮算成一个单元。
4. ⚠️ **`groups` 为空时的退化路径**：镜头表只剩汇总句、一行镜头都读不出来时，
   按 `UNIT_FALLBACK_SHOTS`(=3) 对 `1..trustedTotal` 硬切一份，只为让「分组下标 = 单元号」这条链不为空。
   此时编号与范围的一致性本来就无从保证 —— **别再往这里加更聪明的猜测**。

**同步改掉的两处文案**（`阶段` 含义从「镜头出过」变成「单元兑现过」）：

| 位置 | 旧 | 新 |
|---|---|---|
| `stageCards.ts` `step6Card` 的 `question` | 全片镜头都出过了。 | 全片单元都出过了。 |
| `i18n` `chat.stage.step6Done`（中/英） | Every shot in the film has been written. | Every unit in the film has been written. |

#### 回归验证（必跑，探针脚本模式同 §3.9）

`.tmp/probe_unit2.ts`（esbuild 打 cjs → 结果写 UTF-8 文件再读，控制台是 GBK）：

- **真实会话**：本仓 `users/8/chat/f820537f-…json` 会话[0]（3 个单元各自锚点+正文，
  外加被污染成 U3/U4/U5 的锚点）⇒ 断言
  `{"totalShots":8,"done":3,"next":4,"nextShots":"","finished":true}`。
  **修前**是 `next:6`（坑一）或 `next:2 / nextShots:"Shot 4 - Shot 5"` 永远不动（坑二）。
- 合成七组：⑦ 锚点被污染成 U3/U4/U5 ⇒ `next:3 / "Shot 6 - Shot 8"`；
  ⑧ 同一单元重出三次 ⇒ 不跳号（`next:3`）；⑨ 三个单元全出完 ⇒ `finished:true`；
  ⑩ 老锚点不带 `【单元】` ⇒ 算作 U1（`done:1 / next:2 / "Shot 4 - Shot 5"`）；
  ⑪ U1 两次都是中断占位 ⇒ `done:0 / next:1`（**不可当作出过**）；
  ⑫ 中断后再出一份真正文 ⇒ `done:1 / next:2`。

---

### 3.11 第六批：视频生成弹窗「缩小 → 右侧停靠小窗 + 完成提示条」

**为什么要做**：内层 `VideoGenDialogInner` 原来是**关闭即卸载**（外层 `if (!isOpen) return null`），
而卸载会触发续接 effect 的 cleanup `pollAbortRef.current.abort()` ⇒ 视频作业即使仍在服务端跑，
客户端也不再续接、**成片不落盘**（直接踩 §12.4）。停靠小窗让用户「缩起来继续干活」时，
轮询与成片落盘全程不中断。

**源仓**：`D:\Story-Local`（**只有它有这套代码**，其余版本都没有）。

#### 必须原样复制的文件（3 个）

| 文件 | 动作 | 注意 |
|---|---|---|
| `src/features/videoGeneration/dockTitle.ts` | 逐字复制 | 纯函数、零依赖、零 React |
| `src/features/videoGeneration/VideoGenDock.tsx` | 逐字复制 | 仅把文件头注释里引用的**行号**更新成本仓实际行号 |
| `src/index.css` 的 `video-dock-scan` 段 | 逐字复制 | 并把 reduced-motion 回退**并进已有**的 `@media (prefers-reduced-motion: reduce)` 块 |

#### i18n（各 10 个 key，两个语言包都要）

```
videoGen.minimize / dockExpand / dockWaiting / dockDone / dockView /
videoGen.dockIdle / dockHistoryCount（含 {{count}}）/ completedToast / completedToastNamed（含 {{title}}）/
videoGen.estimateHint
```

> ⚠️ **`estimateHint` 按各仓自己的实际耗时改**：本仓镜像弹窗自己的既有字面量「预计需要 30–60 秒」，
> Local 是「6–24 分钟」（它的模型速度不同）。这条**不要照抄**。
> ⚠️ Local 每个 `t()` 都带 `defaultValue` 字面量；本仓 §11.2-(3) 要求「代码里只引用 key，
> 不写 fallback」⇒ 移植时**去掉全部 fallback**。
> ⚠️ 「缩小」用新 key，**不复用** `titleBar.minimize`（窗口按钮语域，不是一件事）。

#### `VideoGenDialog.tsx` 三处改动（形状相同，但**每仓必须重算两处**）

1. **外层 host**：`docks: DialogPayload[]` + `replaceSlot`(命中**原地替换**，不搬队尾) +
   `removeSlot` + `slotKeyOf(p) = p.nodeId ?? NO_NODE_KEY`（**五处调用点共用同一个键函数**）+
   `isOpenRef`（`handleOpen` 被 `useEffect(…, [])` 锁死首帧 state ⇒ 读「当前值」一律走 ref）+
   常驻 `dockCol` 容器 + 槽位表（**写序承重：dialog 覆盖 docked**）+ `VideoGenToast`。
   **删掉 `if (!isOpen) return null;`** —— `<VideoGenDialog />` 从此常驻渲染。
2. **内层**：新 props（`variant` / `dockContainer` / `onMinimize` / `onExpand` / `onDockClose` /
   `onJobComplete`）、新派生块（`jobStartedAt` / `prevGeneratingRef` 跳变通知 / `nodeExists` /
   `nodeTitle` / `dockSubtitle` / `currentPayload` / `handleMinimizeClick`）、
   docked 提前 return（**必须在所有 hooks 之后**）、标题栏加 `Minus` 缩小按钮 + 节点名。
3. **`dialogTitle` / 提示条文案**：`completedToastNamed` 带 `{{title}}`。

**六条移植约束（评审时逐条对照）**：

1. 🔴 **`docks` 必须是数组**：单槽会让先前作业的 key 从槽位表消失 ⇒ React 卸载它的内层 ⇒
   `abort()` 掐断轮询 ⇒ **成片不落盘**。这是**修缺陷**，不是加功能。
2. 🔴 **`replaceSlot` 必须「命中即原地替换」**：卡片是 portal 进容器的，React 对 portal
   **只追加、重排数组不移动已挂载的 portal** ⇒ **DOM 顺序 ≡ 挂载顺序，不是数组顺序**。
   改成先删后加 ⇒ 同一张卡重新挂载（再次 abort）+ 跳到末尾。
3. 🔴 **必须 `createPortal`，不能嵌进容器子树**：嵌进 = React 树里**换父节点** ⇒ 重挂载 ⇒ 同上。
   且 `fixed` 必须定位在**容器**上，卡片自己不能有 `fixed`（否则多张卡完全重叠）。
4. 🔴 **`handleExpand` 绝不能走 `handleOpen` 重新解析**：`handleOpen` 每次实时读
   `data.frames[].description` / `shotFrameMap` / 在边回溯。用户在缩小期间改了逐格描述或删了连线，
   复用它会**展开回来的参考图与逐格描述和生成时不一致** —— 直接踩 §12.4「所见即所得」。
   ⇒ `payload` 是「挂载时那一份」的存档，展开**原样恢复**。
5. 🔴 **`key={nodeId}` 是承重结构**：既保「换形态不换实例」，又保「换节点真重挂载」
   （`seededRef` 只跑一次且不随 nodeId 重置，不重挂载会把 A 的提示词/成片写进 B 的 `configs[nodeId]`）。
6. ⚠️ **`handleToastDismiss` 必须 `useCallback`**：`VideoGenToast` 的 10 秒定时器把
   `onDismiss` 放进依赖数组 ⇒ 内联箭头每次宿主渲染都换身份 ⇒ **提示条被无限续命**。

#### 每仓必须**重新算**的两处（不能照抄）

| # | 位置 | 为什么 |
|---|---|---|
| 1 | `handleMinimizeClick` 里的**浮层清理 setter 列表** | 照抄 Local 会**编译失败**：它清的 `setShowRefPicker` / `setShowDownloadMenu` / `setRefViewer` 本仓**三个都没有** ⇒ `Cannot find name`。正确做法是**对着本仓自己的 `useState` 列表过一遍**（本仓 5 个：`showHistory` / `addMenuOpen` / `showAssetPicker` / `showConfirmDialog` / `showPromptPicker`）。**故意不清** `showInsufficientDialog` / `showRecharge`（明确失败路径的语义，不该被缩小动作静默吞掉）。 |
| 2 | `estimateHint` 文案 | 见上，按各仓实际耗时。 |

#### 两条硬约束（写进 `VideoGenDock.tsx` 文件头，**后人别破**）

1. **不许加「重新生成 / 重试」按钮**：驱动 `generationPhase` 的只有内层那个 `deps: []` 的续接
   effect，它**只在挂载时评估一次** `savedConfig.pendingTaskId`；侧栏里新起的作业没有任何东西去轮询它，
   按下去只会得到一个永远停在「排队中」的死状态。
2. **不许显示百分比**：后端 `VideoPollResult` 只有 `queued|running|succeeded|failed|retry`，
   **没有进度字段**。不定量条纹是刻意的。时长口径写「**本次已等待**」而不是「已生成 N 分钟」
   （它量的是 `startPolling` 的 `startTime`，跨会话续接会从 0 重算）。

#### 验证清单（T1–T8）

| # | 场景 | 断言 |
|---|---|---|
| T1 | 缩小 → 展开往返 | 画幅/时长/参考图/提示词/逐格描述**逐字一致**；秒数**接着走**不从 0 重算；日志里 `banana_poll_video_job` **无间断** |
| T2 | 两个作业并存 | 两张卡同时在、各显不同摘要；A 的秒数在 B 操作期间**持续增长**（A 的轮询没被掐断）；各回各格 |
| T3 | 浮层开着时缩小 | 「历史记录」/「+ 添加参考图」开着时缩小再展开 ⇒ **不自动弹出** |
| T4 | 节点被删 | 卡片仍在、展开**禁用**、完成后**不出现**「查看」 |
| T5 | 重启 app | **没有**任何小窗卡（dock 状态不落盘，设计如此）；重开该节点走既有 `pendingTaskId` 续接 |
| T6 | 提示条 | 弹窗**关着**时完成 ⇒ 底部居中、**10 秒自动消失**（反复让宿主重渲，**不得**无限续命 —— 这就是 `handleToastDismiss` 必须 `useCallback` 的原因）；弹窗**开着**时完成 ⇒ **不弹** |
| T7 | 静态 | `npx tsc --noEmit` 零错误；中英切换无裸 key 泄漏；卡片文案在 280px 下不爆行 |
| T8 | §12.4 冻结区（**用 diff 证明**） | `git diff -U0 -- src/features/videoGeneration/VideoGenDialog.tsx \| grep -E "^[+-].*(saveConfig\(\|addToHistory\(\|forcePersistVideoGen\(\|hydrateVideoGenStore\|configs\[nodeId\])"` **不得命中调用点**；`videoGenStore.ts` 与 `src-tauri/**` **不出现在** `git diff --stat` |

**必查（移植时最容易漏的挂载点问题）**：`<VideoGenDialog />` 的挂载点必须在
`view === 'canvas'` 条件**之外**（本仓在 `App.tsx` 里是 `<Canvas />` 的兄弟节点）。
若挂在 canvas 分支里，切视图会卸载内层 → 掐断轮询。

**已知瑕疵（与 Local 一致，默认保留）**：`historyCount` 用的是 `combinedHistory.length`，
把「正在生成」那条也算进「已完成 N 条」（要更准可换成 `historyEntries.length`，一行改动，
但会偏离 Local）。弹窗打开时其他作业的小窗卡被 `z-[140]` 暗遮罩压在下面（Local 同，功能无影响）。

---

### 3.12 第七批：视频定价改为「720P 单档 · 0.3 元/秒」

**决策**（2026-10-13）：下线 1080P，只卖 720P；单价 0.3 元/秒 ⇒ **3 积分/秒**
（线上 1 积分 = 0.1 元，`system_configs.credits_per_yuan = 10`），15 秒 = 45 积分。改前 15 秒：720P = 93、1080P = 120。

**为什么只有客户端两处要改**：服务端**不参与视频定价** —— 网关 `/jy/api/v1/ai/image` 里
`deduct_credits_val = request.credits`（`/jy/backend/app/api/endpoints/ai.py:163`）**照单扣费**，
金额由客户端 Rust 算好传上去（`banana_consume_credit` 的 `credits_override`）。
所以「改价」= 改这个仓的两处，**缺一不可**：

| 文件 | 改什么 |
|---|---|
| `src/features/videoGeneration/videoPricing.ts` | `VIDEO_PRICING` 由 `时长 → {720P, 1080P}` 改为 `时长 → 积分` 单值；`VIDEO_RESOLUTION_OPTIONS` 只留 `'720P'`；`computeVideoCost(duration, hasVideoInput)` **去掉 resolution 形参**（3 处调用点同改） |
| `src-tauri/src/commands/banana_api.rs` | `banana_submit_video_job` 的 `base_credits` 由 `match (duration_seconds, is_1080p)` 改为**只按时长**；兜底由 `_ => 100` 改为 `other => other * 3`（同口径，避免未知时长按旧价扣费） |

**新表**：

| 时长 | 4 | 6 | 8 | 10 | 12 | 15 |
|---|---|---|---|---|---|---|
| 积分 | 12 | 18 | 24 | 30 | 36 | 45 |

**三个坑**：

1. **1080P 在本仓早就名存实亡，但要逐仓确认**：本仓那个选择器是 `{false && (…)}` 的隐藏状态
   （注释「暂时隐藏，默认720P」），`resolution` 状态恒为 `'720P'`、从未被 `setResolution` 改过
   ⇒ 改价前实际一直按 720P 档计费。**若某仓的选择器是开着的，那是真的在卖 1080P**，不能照抄本仓表。
2. **别把 `VideoResolution` 类型收窄成 `'720P'`**：`configs[nodeId].resolution` 里可能存着旧值
   `'1080P'`（`videoGenStore.ts` 的 `resolution?: VideoResolution`）。保持联合类型旧配置才不炸；
   它已不参与任何分支。§12.4-5「数据结构变更必须向后兼容」。
3. **`hasVideoInput` 的 1.5× 是死逻辑，本次没动**：前端三处调用一律传 `false`，且提交时**从不传
   `video_input`** ⇒ Rust 里 `has_video` 恒为 `false`。别顺手删，将来真要卖视频生视频时还要用。

**本仓另做的清理**：删掉那个 `{false && …}` 的 1080P 选择器块（它同时是 `VIDEO_RESOLUTION_OPTIONS`
的唯一消费点），`useState` 改为 `const [resolution] = useState<VideoResolution>('720P')`
—— 它仍写进配置与提交参数供后端 `quality` 字段用，只是不再参与计价。
**`resolution` 形参不能从 Tauri 命令上摘掉**（前端 invoke 仍在传这个字段）。

**验证**：

- `npx tsc --noEmit` 零错误；`cd src-tauri && cargo check` 无新增警告。
- 界面：4/6/8/10/12/15 秒分别显示 12/18/24/30/36/45；点生成后日志 `[扣费成功]` 的 `total_credits` 与界面一致。
- 端到端（**测试账号**）：15 秒任务 ⇒ 服务器 `consumption_records` 里 `credits_consumed = 45`、`action_type = video_generation`。
- 退费兜底：`banana_poll_video_job` 里 `credits_deducted > 0 ? credits_deducted : 30` 的 `else 30`
  是旧价遗留，**本次未改**（只在续接拿不到已扣金额时兜底）。

---

### 3.13 第八批：升级弹窗「更新日志过长 ⇒ 按钮被顶出屏幕」

**症状（v1.0.78 发布后用户实测上报）**：把发布日志写到 757 字时，老客户端弹出的升级窗把「直接下载安装」顶到了屏幕外 —— 点不到、也没有滚动条 ⇒ **用户直接升不了级**。用户原话：「更新日志太长了，用户根本看不到下载按钮」。

**根因（代码可证，不需要复现）**：`src/components/ui/primitives.tsx` 的 `UiModal`（L461-502）正文区是裸的一层：

```tsx
<div className="px-4 py-4">{children}</div>   // :492 —— 无 max-height、无 overflow
```

而遮罩是 `flex items-center justify-center` ⇒ 面板内容一超高，就**上下同时溢出**，footer（三个按钮所在）被推出可视区，且**没有任何可滚动容器**能把它找回来。**这是全仓所有弹窗共用的组件**，不止升级弹窗。

**改法（一行 class + 一段注释）**：`src/components/UpdateAvailableDialog.tsx` 的日志 `<pre>`：

```diff
-<pre className="whitespace-pre-wrap text-xs text-text-muted leading-5">{notes}</pre>
+{/* 日志必须限高并可滚：UiModal 正文区无 max-height，面板一超高就上下同时溢出，
+    底部三个按钮会被顶出屏幕且无处可滚（2026-10-13 线上事故）。
+    38vh + 本弹窗其余固定内容 ≈ 470–550px，最小窗口（600px）下按钮仍可见。 */}
+<pre className="max-h-[38vh] overflow-y-auto ui-scrollbar whitespace-pre-wrap text-xs text-text-muted leading-5">{notes}</pre>
```

`.ui-scrollbar` 见 `src/index.css:140`。**为什么是 38vh**：本弹窗除日志外的固定内容（标题 + 描述 + 版本行 + padding）约 240–300px，`38vh` 在最小窗口 600px 下约 228px ⇒ 合计仍留出按钮空间；换 50vh 会在小窗口重新把按钮顶出去。

**配套纪律（比代码更重要）**：给 `version_*.json` 的 `notes` 用**短版**（≤300 字），完整日志留在 `docs/releases/vx.y.z.md` 与 tag 正文里。代码限高只是兜底，**服务端文案才是第一道闸** —— 它同时决定弹窗与下载页两处的观感。

**同源风险（本次未修）**：`UiModal` 本身仍未限高 ⇒ 其他正文可能变长的弹窗同样脆弱。本次只修出事故的那一个（最小改动、可回退）；根治要给 `UiModal` 正文区加 `max-h` + 滚动，那是全局行为变更，需单独评估。已记入 §7。

**验证**：本地把 `version_shortvideo.json` 的 `notes` 临时改成 1000 字 → 弹窗出现时**三个按钮全部可见**、日志区可独立滚动；把窗口缩到 600px 高仍可见；改回短文案后布局与之前一致。

---

### 3.14 第九批（运维）：发布与升级链路的四条硬规则 + 远端实况

发 v1.0.78 / v1.0.79 时踩出来的，`docs/shengji.md` 里原先没写全。**各版本的 SOP 是 `shengji.md` 的分身，这几条同样适用。**

| # | 规则 | 为什么（实测证据） |
|---|---|---|
| 1 | 升级弹窗的 `notes` **≤300 字** | `UiModal` 正文区无 max-height（§3.13）。完整日志放 `docs/releases/vx.y.z.md` 与 tag 正文 |
| 2 | **下载页按行定点替换，禁止全局 `sed`** | 页面用的是**带版本号的绝对链接**（`http://47.108.237.10/jy/uploads/app/<产品名>_<版本>_x64-setup.exe`），不是老 SOP 写的 `../xiaoya-studio/` 相对路径；而且**macOS 按钮也写死版本号**。只发 Windows 时做全局替换，会把 macOS 按钮改成指向不存在文件的死链。改前备份 `index.html.bak.v{被替换掉的版本}`，改后 `diff` 确认只有目标行变化 |
| 3 | `version_*.json` 必须等 **Windows exe + macOS dmg 都上传完**再翻版本号 | 客户端用 `update.rs` 的 `installer_name()` 按平台拼地址：Windows `..._{v}_x64-setup.exe`、macOS `..._{v}_universal.dmg`。翻早了，macOS 用户点「直接下载安装」直接 404 |
| 4 | **dmg 是「边写边可访问」的半成品** | CI 用 SCP 直写目标文件，**上传过程中 `curl -I` 就已经返回 HTTP 200**，而 `Content-Length` 是当时的半成品大小（实测 128,253,952 → 最终 279,543,444）。必须**连续两次读数一致且量级合理**（>250MB）才能动 JSON 与下载页，否则用户下到截断的 dmg，报「文件校验失败」。CI 出 dmg 实测**约 7 分钟**（1.0.78 与 1.0.79 均如此），远快于老资料里的 50 分钟 |

**上传 exe 必须留两份**：中文原名（下载页给人看）+ **英文名副本**（客户端硬编码 `installer_name()` 的英文名，缺了报 1392）。各版本同理，只是产品名不同（`Storyboard-ShortVideo_` / `Storyboard-Science_` / …）。

**远端实况（2026-10-13 实测 · 短视频版仓）**：

| 远端 | 地址 | 状态 |
|---|---|---|
| `ci` | `sunsh-sunsh/storyboard-mac` | ✅ 可用 |
| `ci-mac` | `yaojie-sun/mac1` | ✅ 可用 |
| `gitee` | `sunsh0704/storyboard-shortvideo` | ✅ 可用 |
| `origin` | `sun-lzy/storyboard-mac` | ❌ `Bad credentials` |
| `sunsh0704` | `sunsh0704/storyboard-mac` | ❌ token 失效 |

⇒ SOP 阶段二写的「push `sunsh0704` + push `origin`」**在本仓两条都已失效**，实际可用的是 `ci` / `ci-mac` / `gitee`。**推之前先只读验一遍**（`GIT_TERMINAL_PROMPT=0 git ls-remote <remote>`），别照抄 SOP 里的远端名。

**科普版不受这条影响**，但要记住它自己的两条惯性：

- 只有一个远端 `origin` = `yaojie-sun/storyboard-science`（实测可达），`scripts/release.mjs` 就是推它；tag 触发 `.github/workflows/build.yml` 构建 macOS dmg 并 SCP 上传到 `47.108.237.10:/jy/uploads/app/`。
- `release.mjs` 的 `git add` 名单**只有 5 个文件**（`package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/tauri.conf.json`）⇒ 每次发版后要**人工补一次提交**，把两个脚本不管的文件纳进来：① `public/version_science.json`（**要一并 scp 覆盖服务器上的同名文件**）；② 下载页卡片（`public/industry.html`，科普版卡片在**行业专版页**里，不在 `install_guide/index.html`）。
    ```bash
    git add public/industry.html public/version_science.json
    git commit -m "chore(release): 同步下载页与版本信息 v{版本号}"
    ```
  另注：科普版仓库的 `.gitignore` 原本把 `docs/shengji.md` 排除了，现已在 `.gitignore` 里加 `!docs/shengji.md` 白名单放行，让它和服饰/旅游/短视频版一样进版本库。

---

### 3.15 第十批：提示词按条计费 + 视频页/定价一律照基线 + 消费清单去噪

**这一批是「美妆版复刻时走偏」的回灌**。走偏的三处，当初都被当成了「各版本可自行决定」；
本批的重点因此不是代码量，而是**取消这些自由度**：视频页与视频定价属**协议层**，不属 `§4` 的产品语境定制。

#### 3.15.1 🔴 视频页与视频定价：不许「保留各版本自有档位」

| 走偏做法（美妆版实测） | 后果 | 正解 |
|---|---|---|
| 定价保留自有六档 `{4:35,6:45,8:55,10:65,12:78,15:93}`、兜底 `other * 6.2` | 同一模型跨版本价差近 2 倍，用户对不上账 | **一律 3 积分/秒**（§3.12 表），兜底 `other * 3`；`videoPricing.ts` 与 `banana_api.rs` **两处必须同改** |
| 保留「云端 2K / 云端 4K / 本地 4K」三个超分按钮 + 两个确认弹窗 | 交互与基线分叉，用户看到「生成完还得自己点超分」 | **全删**，照基线改「生成完成后**自动**本地超分到 2K」（见 §3.15.2） |

**只有一处要按仓确认**：该仓的 1080P 选择器是**隐藏**还是**开着**（§3.12 坑 1）—— 开着就是真的在卖 1080P，
不能照抄本仓表。其余一律照基线。

#### 3.15.2 删掉超分按钮，改为「生成完成后自动本地超分到 2K」

**只删 UI，不删后端**：`baidu_upscale_video`（云端 2K/4K，20/35 积分）保留，与基线一致 —— 只是不再从视频页按钮进入。
改动集中在一个文件：`src/features/videoGeneration/VideoGenDialog.tsx`（基线同名变量逐字相同，可整段照抄）。

**① 先加 `autoEnhanceTo2K`**（基线对应函数的整段）：内部 `await enhanceVideo(localVideoPath, 2)`，
**失败回退原片**（不抛、不阻塞出片），并驱动既有的 `isLocalEnhancing` / `localEnhanceProgress` 蒙版
（进度是**模拟**的：0→90% 约 3 分钟，2500ms 一跳）。**不要**把它加进 `handleGenerate` / `startPolling` 的依赖数组（基线也没加）。

**② 两个调用点各插 3 行，并改掉落盘入参**：

| 路径 | 由 | 改为 |
|---|---|---|
| 轮询路径 | `config.videoUrl = localVideoPath` | `const finalVideoPath = await autoEnhanceTo2K(localVideoPath)` → `videoUrl` 与 `generatedVideoUrl` 都用 `finalVideoPath` |
| 同步路径 | 同上（变量名 `syncVideoPath`） | 同上 |

**③ 再删**（**自下而上**删，别从上往下）：

| 内容 |
|---|
| 三个按钮：`云端 2K (-20积分)` / `云端 4K (-35积分)` / `本地 4K (免费)` |
| 两个确认弹窗（云端超分确认 / 本地 4K 硬件要求确认，含「以后不再提示」checkbox 与 localStorage 读写） |
| 状态 `showLocalEnhanceConfirm` / `isUpscaling` / `upscaleTarget` / `showUpscaleConfirm` / `enhanceSuppressVideoConfirmRef` |
| `handleLocalEnhance` 整个函数（已被 `autoEnhanceTo2K` 取代） |
| 预览区「生成中」文案里的 `isUpscaling` 分支与两处前缀（删完与基线逐字相同） |
| import 里的 `UiButton`（恢复基线 `import { UiModal, UiChipButton } from '@/components/ui';`） |

**保留**：`isLocalEnhancing` / `localEnhanceProgress`、进度蒙版、`enhanceVideo` import（新函数仍在用）。
⚠️ **孤儿 localStorage 键 `enhance:suppressVideoConfirm` 不要顺手删**——删就是动用户数据（§12.4-3）。

⚠️ **顺序陷阱（先查该仓 tsconfig 再动）**：许多仓开了 `noUnusedLocals` + `noUnusedParameters`
⇒ **必须先把 `autoEnhanceTo2K` 接上、再去删旧 UI**，否则中间态会因「已声明未使用」直接编译失败。
删完必须再跑一次 `tsc`；残留关键字自查（应为空）：
`grep -rn "isUpscaling\|upscaleTarget\|showUpscaleConfirm\|showLocalEnhanceConfirm\|enhanceSuppressVideoConfirmRef" src/`

**④ i18n（两处，别误伤）**：

- 生成按钮：`videoGen.generate` → `生成视频（2K）` / `Generate Video (2K)`（`zh.json` / `en.json` 同改）
- 组件内 fallback 字面量同步：`t('videoGen.generate', '生成视频（2K）')`
- 🔴 **不要动** `node.videoGen.generate`（节点卡片标签，各版本本来就相同）

**⑤ 成片源变了（必须同步告知产品侧）**：`videoUrl` / `generatedVideoUrl` 从此指向**本地 2K 文件**，
节点缩略图 / 下载 / 历史记录一并变 2K。用户感知是「生成完还要再等 2-5 分钟」。**窗口期风险**：
`autoEnhanceTo2K` 在 `saveConfig` **之前** await ⇒ 这 2-5 分钟内本次成功结果尚未入库；
但 `pendingTaskId` 更早就已落盘，重开节点会续接轮询、重下重超分 ⇒ 属「窗口期」而非「必丢」。

**⑥ §12.4 冻结区自查（要求空输出）**：

```bash
git diff -U0 -- src/features/videoGeneration/VideoGenDialog.tsx \
  | grep -E "^\+.*(saveConfig\(|addToHistory\(|forcePersistVideoGen\(|hydrateVideoGenStore|configs\[nodeId])"
```

两个调用点的函数、时机、字段结构、`if (nodeIdRef.current)` 包裹、`forcePersistVideoGen` 位置**全不变**，
唯一变化是入参 `config.videoUrl` 的**取值来源**；被删的持久化调用点全属被删除的功能（属「删调用点」而非「改链路」）。

#### 3.15.3 提示词计费：一条提示词 = 1 积分（不是每步 1 分）

**症状**：一条完整提示词在消费清单里出现 **8 行「提示词生成 −1」**，观感是每一步都扣 1 分。
**成因**：写手链一条提示词 = **8 次网关调用**（`chatStore.ts` 的 MAIN_CHAIN STEP0…STEP6 + 自动串链），每步独立计费。
**客户端在这条链路上没有任何扣费代码** —— 钱在**自有网关**按请求体 `billing_tag` 扣
（无标记走 token 阶梯，每步落一条 `action_type=text_generation`）。

| 侧 | 改动 |
|---|---|
| **服务端** | `/jy/backend/app/api/endpoints/gateway.py` 的 billing_tag 分支新增 `elif billing_tag == "prompt_continue": required_credits = 0`（照抄旁边 `inspiration_continue` 的写法），并把该字段的 `description` 补一句 |
| **客户端** | 三仓各 **1 行**：`src/stores/chatStore.ts` 自动串链处 `sendMessage(nextAnchor, undefined, { auto: true })` → `'prompt_continue'` |

用户**手动**发起的三个入口**保持无标记**（各扣 1 分）：`ChatInput.tsx`（输入框，💡爆款灵感另带 `inspiration`）、
`ChatPanel.tsx`（阶段卡片）、`FillGridButtons.tsx`（宫格分镜）。⇒ 恰好等于「一条提示词 1 分」。

🔴 **时序：服务端价目先上，客户端后发。**
⚠️ **但本网关的失败模式比预想温和**：未知 tag 落 `else` 分支 ⇒ 走 token 阶梯计费（**会被正常扣分**），
既不白送也不断链。**换网关实现时必须重新确认这一条** —— 若某实现是「未知 tag 报错」或「按 0 计费」，
先发客户端的后果就分别是**断链**或**白送**。

**Rust 不用改**：`chat.rs` 原样透传 tag。⚠️ 特别地，`intercept_search_and_continue` 里那个 `continue_tag`
（`Some("inspiration") → inspiration_continue`，`_ => None`）**不要给它加 `prompt_continue` 分支** ——
它只服务灵感链（`<search>` 全仓只存在于该拦截器自身），写手链走不到。

**残留（本次未修）**：美妆/科普的 `chat.rs::call_gateway_once` 有 `MAX_ATTEMPTS = 2` 空响应重发
（**短视频基线没有**）—— 首步（无标记）重发会**多扣 1 分**；续步带标记后重发已免费。
根治需服务端加「同一逻辑请求重发不重复计费」+ 客户端带 `prompt_retry`，属独立一步。

#### 3.15.4 消费清单隐藏 0 分流水

网关为每次调用都写一条流水（`credit_consumption_logs`），续步的 0 分记录会在用户侧清单堆成一串 `-0`。
**在用户侧过滤、账本保留**（改 `src/components/ConsumptionHistoryDialog.tsx` 的 `filteredRecords`，加一行谓词）：

```ts
if (r.credits_consumed === 0) return false;
```

选客户端过滤而非服务端：流水留着才能对账，管理端仍看全量。
副作用：底部「加载更多 (n/total)」的计数取自原始条数（含被隐藏的 0 分），比实际看到的行数大。

#### 3.15.5 服务端运维两条（动网关文件前必读）

1. **网关价目文件的真实位置**：`/jy/backend/app/api/endpoints/gateway.py`
   （`claude-gateway.service` → `/jy/main.py` 把 `backend.app.api.endpoints.gateway` 挂在 `/api/v1/gateway`）。
   ⚠️ **不是**客户端仓里那个 Streamlit 后台（`jiaoyan/`）—— 那份**完全没有 `billing_tag` 逻辑**，改它没有任何效果。
2. **两个会咬人的自动化**（都在 `/jy/watchdog.sh`，cron `*/3 * * * *`）：
   - `protect_files()` 把 `gateway.py` / `main.py` **强制 chmod 444** ⇒ 改文件要 `chmod u+w` → 改 → **改回 444**。
   - **Level 3 会从 `/jy/backups/stable/<最新>/backend/` 整目录回滚**（`rm -rf` 后覆盖）。
     最新稳定备份若早于你的改动，网关一旦连续不可用就会把这次价目**静默回滚**。
     ⇒ 改完网关文件，**把改后的文件同步进当前稳定备份目录**，或至少记下风险与回退点。

**改网关后的验证**：

```bash
systemctl restart claude-gateway && sleep 10
systemctl is-active claude-gateway                    # active
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H 'Content-Type: application/json' \
  -d '{"username":"healthcheck","password":"healthcheck"}' \
  http://127.0.0.1:3003/api/v1/auth/login             # 401（看门狗同款探针）
journalctl -u claude-gateway --since '2 min ago' | grep 计费   # 逐次调用的 tag 与扣分数
```

---

## 4. 各垂直版本的定制点（只需改这些）

移植时**只有下面几处**需要按版本改写，其余全部原样：

| # | 位置 | 短视频版现状 | 其他版本应改成 |
|---|---|---|---|
| 1 | `SKILL.md` 的产品语境段 | 企业商业短视频 / 6 格商业信息节点（Hook→Context→Demo→Proof→Outcome→CTA） | 各自行当的分镜逻辑（服饰＝穿搭展示、科普＝知识拆解、萌宠＝情绪反差…） |
| 2 | `SKILL.md` 违禁场景词 / 违禁词表 | 阿里云违禁场景词 + 模型名表 | 各行当的合规词（美妆/大健康尤其要补） |
| 3 | `i18n` 里的按钮与阶段名 | 生成宫格图 / 直接生成视频 | 若各行当要用不同措辞，改这里 |
| 4 | `block_constraints.md` / `block_mapping.md` | 通用 + 六段式 + 内容铁律 | 🔴 **原样**（这是跨版本一致的硬约束，不要按行当改） |
| 5 | `writer_rules/step_shapes.md` | STEP0–9 形状 | 🔴 **原样**（产品差异靠 SKILL.md 承载） |
| 6 | `video_gen_rules_minimax_h3{,_direct}.json` | **线上已是产品中立**（六段式官方格式：`短视频`/`科普`/`导演`/`摄影师` 均 0 处命中），无需按版本改产品词 | **通常原样复用线上文件** —— `update.rs` 的 `mode` 分键已足够。若某仓确实要换规则头，**必须用本仓专属文件名**上传，否则会覆盖其他版本共享的同一份线上文件（2026-10-13 实测：这两份是跨版本共享的） |
| 7 | `nodeDisplay.ts` 默认名 | `直出视频` | 可保留 |
| 8 | `docs/skills/version.txt` 的 `name:` | `xiaoya-ai-cinema-shortvideo` | 各版本自己的 skill 名 |
| 9 | 视频定价 + 视频生成页（§3.12 / §3.15） | 720P 单档 · 3 积分/秒（15 秒 = 45）；生成完**自动**本地超分到 2K | 🔴 **照基线，本项不设自由度**：定价与视频页属**协议层**。两处（`videoPricing.ts` + `banana_api.rs`）必须同改；**不许「保留本版本自有档位」，也不许留着旧的超分按钮**（美妆版走过这条路，见 §3.15.1）。唯一要按仓确认的是该仓的 1080P 选择器是**隐藏**还是**开着**（§3.12 坑 1）—— 开着就是真的在卖 1080P，不能照抄本仓表 |
| 10 | 提示词计费额度（§3.15.3） | 一条提示词 1 积分（续步 0 分，网关 `prompt_continue`） | 🔴 **原样**（属 §12.2 计费，改额度需单独审批） |

---

## 5. 移植后验证清单

### 5.1 机械检查（每次必跑）

```bash
npx tsc --noEmit                 # 前端零错误
cd src-tauri && cargo check      # Rust 零错误

# 旧话术残留检查 —— 命中的每一处上下文都应带「禁止/不要/不再输出」
grep -n 'G-生成\|X-修改分段\|A-生成\|B-不生成\|继续-生成下一段\|【继续确认】' docs/skills/SKILL.md
grep -n 'G-生成\|A-生成\|B-不生成\|继续' src-tauri/src/commands/chat.rs   # 应为空

# 超分按钮残留（第十批，应为空）
grep -rn "isUpscaling\|upscaleTarget\|showUpscaleConfirm\|showLocalEnhanceConfirm\|enhanceSuppressVideoConfirmRef" src/

# §12.4 冻结区（第十批涉及视频弹窗时必跑，应为空）
git diff -U0 -- src/features/videoGeneration/VideoGenDialog.tsx \
  | grep -E "^\+.*(saveConfig\(|addToHistory\(|forcePersistVideoGen\(|hydrateVideoGenStore|configs\[nodeId])"
```

### 5.2 端到端（**只能用测试账号**，会消耗积分）

1. **锚点轮**：打开有 ≥2 个资产的测试项目，发一条创意 → 写手回 STEP 内容，
   **末行独占一行**是 `【阶段】STEP<m>`，气泡外的选项卡正确出现。
2. **自动串链**：确认 STEP0 → … → STEP6 自动推进，到 STEP6 停下。
3. **宫格路**：点「生成宫格图」→ 画布落宫格节点 + 参考图上传节点 + 连线；
   视频弹窗提示词 = 气泡里那份（含用户编辑）。
4. **直出路**：点「直接生成视频」→ 画布中心落「直出视频」节点，≤6 个上传节点在
   `centerY+220` 一字排开、各连一条边；弹窗自动打开、提示词/画幅 9:16/时长 4 已预填；
   **不点生成时积分不变**（这一步是 §12.2 的底线）。
5. **持久化**：关弹窗 → 点节点自身生成 chip → 弹窗用**同一份**提示词重开
   （证明预置落在 `configs[nodeId]`）；重启 app 后节点/连线/缩略图/提示词全在。
6. **负路径**：① 无资产项目 → 仍建节点、0 张参考图；② 写手没写【选图】→ 控制台 warn、
   一张都不挂；③ 旧对话（改动前存的）→ 点按钮不崩。
7. **老档案兼容**：用改动前的一个项目打开 — 对话历史、宫格节点、视频节点显示**与改动前一致**。
8. **多单元续写（第二批）**：贴一条**长于 15 秒**的脚本 → 自动串链跑到 `STEP6` 出完第一单元 →
   提示词块下面应出现 **「出下一单元（U2 · Shot 4 - Shot 6）」**；
   点它 → 写手**只出这一组镜头**的六段式正文（不重出上一组、不顺带把后面几组一起写）；
   接着按钮变成下一个单元；全部镜头出完 ⇒ 按钮消失、问题行变成「全片镜头都出过了」。
   ⚠️ 用**改动前就存在的老会话**打开时：读不出镜头表的会话**照旧不出按钮**（fail-open），
   这是预期行为，不要当 bug。
   🔴 **第四批专门为此返工**（详见 §3.9）：再跑一条写手**自己划单元**的脚本
   （镜头行写作 `| **Shot 1**（U1·全片 00:00.000–00:04.000）｜4s |`，
   单元写作 `- **【单元】U2 = Shot 4 – Shot 5**（…，15 秒）｜…`）——
   第一单元出完**必须**出按钮，**绝不能**弹「全片镜头都出过了」。
   纯函数探针（无 IO，可离线跑）比手测更快：见 §3.9 的回归验证。
9. **技能瘦身（第三批）**：跑一条完整串链，看 `[Chat] SKILL.md 已加载 (N 字符)` 那行 ——
   `STEP1/2/3/4/5/5.5` 那几轮 N 应≈**3 万**（带 `技能瘦身：… 已省略` 行），
   `STEP6`、`STEP7/9` 与**每个会话的第一条消息**应≈**7 万**（带 `全量注入` 行或没有瘦身行）。
   若所有轮次都是 7 万且带 warn「技能瘦身未生效」⇒ 本地技能是旧包（没有标记），
   但**不做任何事也是安全的**（fail-open，全量注入）。
10. **自动 2K（第十批）**：生成一条视频 ⇒ 生成完出现本地超分进度蒙版（0→90% 是**模拟**的，约 2-5 分钟）
    ⇒ 成片为 2K，且**节点缩略图 / 下载 / 历史记录拿到的都是 2K 文件**；超分失败时**回退原片、不阻塞出片**。
    视频页**不再出现**「云端 2K / 云端 4K / 本地 4K」三个按钮；按钮文案为「生成视频（2K）」。
11. **按条计费（第十批）**：贴一次脚本走完 STEP0→STEP6 ⇒ 消费清单里应只剩
    **1 行「提示词生成 −1」**（其余 0 分流水已被隐藏）；再点「生成宫格分镜」⇒ 再 +1 行 −1。
    网关日志同轮应见 1 条 `[计费-messages] … 扣分=1` + 7 条 `[计费-提示词续写] 0积分`。
    再关闭并重开该节点的视频页，所见与生成时一致（§12.4 底线）。

### 5.3 日志检查

```
[Chat] 已注入「STEP 门机」形状块（锚点轮）     ← 锚点轮应有
[Chat] 已注入「别停」护栏（首行非控制行）       ← 非锚点轮应有
[Chat] 技能瘦身：本轮 stage=STEP3 ⇒ 官方规范原文已省略（71252 → 29862 字符）  ← 白名单步骤应有
[Chat] 技能瘦身：本轮 stage=STEP6 ⇒ 官方规范原文**全量注入**                ← 出片轮应有
[Chat] SKILL.md 已加载 (29862 字符)           ← 首轮/出片轮应是全量（≈71252）
[Chat] 响应完成 chat_id=… len=… usage={…}     ← 每轮都应有（真实 token，用它核成本）
[Rules] model=…, mode=direct, loading video_gen_rules_minimax_h3_direct.json
[Canvas] 本轮写手没有【选图】⇒ 不挂任何参考图（以写手为准）
```

⚠️ 出现 `[Chat] 响应文本为空 chat_id=… stop_reason=… usage=… raw=…` 时，
**不要重试了事**：那行里的 `raw` 就是网关原样返回的内容，先看它是「只有思考内容」、
「`finish_reason=length`」还是「内容过滤」，三者处置不同。

---

## 6. 移植时绝对不要动

| # | 约束 | 出处 |
|---|---|---|
| 1 | **计费扣点必须在自有服务器执行**，不得绕过/修改/转移到其他路径 | CLAUDE.md §12.2 |
| 2 | 视频生成只走**境内**线路；密钥不落代码 | CLAUDE.md §12.3 |
| 3 | **禁止删除** `app_data_dir/users/{id}/` 下任何文件 | CLAUDE.md §12.4 |
| 4 | **禁止修改** `configs[nodeId]` 读取与表单回填逻辑 | CLAUDE.md §12.4 |
| 5 | **禁止修改** `saveConfig` / `hydrateVideoGenStore` / `addToHistory` 持久化链路 | CLAUDE.md §12.4 |
| 6 | 操作数据文件前**必须先备份 `.bak`** | CLAUDE.md §12.4 |
| 7 | 数据结构变更**必须向后兼容**（新增字段一律 optional） | CLAUDE.md §12.4 |
| 8 | 测试**只能用测试账号** | CLAUDE.md §12.4 |
| 9 | 生产服务器 `47.108.237.10` 的任何改动需**先审批 + 风险分析 + 回退方案** | memory |

**核心链路（生存根本）**：`Chat → 宫格生成节点 → 视频生成节点`。
打开任何一个节点的视频生成页，看到的**必须与生成时一模一样**。断了 = 产品信用归零。

---

## 7. 本次未完成（移植时按需一并做）

| 项 | 说明 |
|---|---|
| **逐格第二遍** | 用户选宫格后，写手**只出 6 格 + `【分镜映射】`**（不再吐一遍提示词）。前端的产方/解方（`buildCellsAnchor` / `parseCellsAnchor`）已就绪，Rust 侧还缺子调用路径 |
| `repairInScreenMouth` | 移植 Local 的画内嘴部修复纯函数（修「画内有台词却写嘴唇闭合」的回归） |
| `@图N → <Picture N>` 提交前翻译 | 越界/越界拦截；**只翻提交文本，绝不写回 config / 节点 / 面板** |
| `injectPropHolders` | 道具持有注入，需先让六段式产出稳定 |
| `docs/h3.md` §3.4 | 同步本次协议变更（SKILL 格式/规则变更必须同步到该文档） |
| 服务器清理 | 生产端 `active_video_model` 与已下线的欢乐马视频行 `id=34` 需按 §12.3 清理（**需单独审批**） |
| **SKILL 瘦身（✅ 已执行，见 §3.8）** | 自动串链**一次提示词 = 8 次网关调用**，每次都要重发整份 system（含 SKILL）⇒ SKILL 体积是**成本的唯一主因**。**做法：官方原文加区块标记 + `chat.rs` 按步注入**（非出片步骤剥掉官方写作规范原文，`SKILL.md` 一个字都不用删）。⚠️ **不能砍的**：六段式契约与段名、台词逐字铁律、运镜闭集、违禁词/违禁场景词、动作密度铁律、人脸光影铁律、「产品标记」三件套（`【选图】`/`【故事梗概】`/`【分镜映射】`）、STEP 门机相关的收尾行约束 |
| **真实 token 实测（✅ 已执行，见 §3.8）** | 用 `[Chat] 响应完成 … usage=` 那 8 行实测：一条链 **287,648 → 227,048 输入 token（−21%）**，剥离的 6 轮每轮省 **7.7k–9.4k**。⚠️ 旧口径「−43% / −58%」是**字符口径**，token 口径不成立（服务器 `estimate_tokens` 高估约 1.9 倍）；改任何**计费额度**属 §12.2，需单独审批 |
| 手打「生成下一段」重跑整条链 | 手动消息恒落 `STEP0` 入料 ⇒ 重跑 `STEP1…6`（8 次调用）。按钮修好后已不是唯一出路，**本次未动**（属行为变更，见 §3.9 末段） |
| **停靠小窗（✅ 已执行，见 §3.11）** | 视频生成弹窗「缩小 → 右侧停靠小窗 + 完成提示条」。⚠️ 移植时**每仓必须重算两处**：缩小时的浮层清理 setter 列表（各仓 `useState` 数量不同，照抄会编译失败）、`estimateHint` 文案（各仓耗时不同） |
| **`UiModal` 正文区全局限高（第八批只修了一处）** | §3.13 是**局部**修法（只给升级弹窗的日志框加 `max-h`）。`src/components/ui/primitives.tsx:492` 的正文区仍是裸 `<div>`，其他正文可能变长的弹窗同样会被顶出按钮。根治要给 `UiModal` 加 `max-h` + 滚动 —— 属**全局行为变更**，各版本一起评估后再动 |
| 视频定价（✅ 已执行，见 §3.12） | 720P 单档 · 3 积分/秒。⚠️ 移植时**每仓必须重算一处**：先确认该仓的 1080P 选择器是隐藏还是开着（藏着才能照抄本仓表） |
| **首步空响应重发的重复扣费（第十批残留）** | 美妆/科普的 `chat.rs::call_gateway_once` 有 `MAX_ATTEMPTS = 2`（**短视频基线没有**）：首步（无标记）重发会**多扣 1 分**。根治需服务端「同一逻辑请求重发不重复计费」+ 客户端 `prompt_retry` 标记，属独立一步 |
| **0 分流水持续写入（第十批）** | 每条提示词多写 7 行 0 分记录（`credit_consumption_logs`），长期纯增长。若嫌涨，可让服务端在 `required_credits == 0` 时不写流水——会失去对账明细，需权衡后再动 |
| **网关价目与稳定备份不同步（第十批）** | `/jy/backups/stable/` 里最新那份还是**改前**的 `gateway.py`；看门狗 Level 3 一旦触发会静默回滚 `prompt_continue` 价目（见 §3.15.5）。要么把改后文件同步进备份目录，要么把这条风险显式记在运维侧 |

---

## 8. 一句话交付

**前端 A 层原样复制、Rust B 层原样复制、SKILL.md 只删旧话术、视频规则 JSON 直接复用线上
那份产品中立的共享文件、§12.4 的四个字段一个都不动** —— 这样各垂直版本就能拿到与短视频版
完全一致的「前端持有光标 + 界面给选项卡 + 所见即所得」体验。
