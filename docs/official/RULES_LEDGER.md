# 规则台账 · 闸门分档与出处

> 本表是「哪些约束可以直接写进代码」「哪些只能作为建议留在热更层」的唯一判据。
> 新增任何闸门（`promptShapeCheck.ts` / `prompt_repair.rs`）或任何 🔴 规则前，先在这里登记；
> 登记不出来的，不许落地。校验：`npm run check:rules`。

## 分档定义

| 档 | 定义 | 放哪 | 判据 |
|---|---|---|---|
| **A** | 确定性事实 —— 一个 `if` 就能判，无歧义 | 代码闸门 | 能写成机检 |
| **B** | 语义要求 —— 需要理解才能判断 | 热更文本（写手规范） | 写不成机检 |
| **C** | 格式契约 —— 前端／后端逐字解析 | 代码，且**不可热更** | 改动会破坏解析 |

**核心口径：官方没有规定 ≠ 禁止。** 只能写成 A 档的检查才有资格拦人；判不了的（B 档）只能当建议。

---

## 一、A 档 · 现行代码闸门（11 项）

前端 `src/features/videoGeneration/promptShapeCheck.ts` 与 Rust `src-tauri/src/commands/prompt_repair.rs`
逐项一一对应。

| # | 检查 | 判据 | 出处类型 | 出处 | 结论 |
|---|---|---|---|---|---|
| 1 | `fields` 六段齐全按序 | 含 subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music，且次序一致 | 官方原句 | *Ref2VA rewrites use `subject_definitions`, `summary`, …, in that order.* | ✅ 保留 |
| 2 | `shots` 镜号从 1 连续 | `[Shot N]` 序贯递增 | 官方原句 | §4.2 *Use sequential shot numbers for later shots* | ✅ 保留 |
| 3 | `dialoguePairs` `<d>` 成对 | 开合标签数量相等 | 官方原句 | §5.4 *…only inside `<d>`…* | ✅ 保留 |
| 4 | `speakerId` 有台词带 `(Sx)` | 含 `<d>` 的行必须含 `<Subject N> (Sx)` | 官方原句 | §5.4 *Assign `(Sx)` once… Reuse the corresponding ID at every actual vocal event* | ✅ 保留 |
| 5 | `voiceoverLips` 画外音配闭唇句 | 触发句 + 点名画内主体 ⇒ 必须有 `lips remain completely closed` | 官方原句 | §4.4 *says in an off-screen voiceover* + *while his lips remain completely closed* | ✅ 保留（「只对画内主体」是我们按原句「the corresponding on-screen character」收窄的，方向是收紧不是加码） |
| 6 | `audioTag` 不许 `<Audio N>` | 命中即报 | 官方原句 + 产品 | §2.4/§2.5 音频资产定义；产品入参恒为参考图 | ✅ 保留 |
| 7 | `summaryTag` 任务类型标签 | `summary` 首个非空行以 `[` 开头 | 官方原句 | §2.6 任务类型标记 | ✅ 保留 |
| 8 | `tooLong` 正文总预算 | 中文 ≥ 1050 汉字 / 英文 ≥ 6500 字符 | **产品条款** | 官方无字符预算；阈值是我们按回译比例定的 | ⚠️ 标〔产品条款〕，不是官方 |
| 9 | `detailedTooLong` 单段预算 | 中文 ≥ 600 汉字 / 英文 ≥ 500 词 | 官方原句（阈值产品化） | §5.2 *`detailed_description` is normally 350-500 English words* | ⚠️ **阈值偏宽**：600 汉字≈600 词，已出官方 350–500 区间上沿；官方另有 *Dialogue-dense content prioritizes fitting the complete spoken timeline*。维持现状可以，但要知道这是产品口径 |
| 10 | `silentMouth` 无台词镜不许写张嘴 | 无 `<d>` 的行出现「张合／开合／无声动嘴」 | 官方范例 **⇒ 推导** | 官方只有范例 *She closes her lips and guards the cookie.*，**没有**「禁止张合」的条款 | ⚠️ 推导型。有生产依据（客户「听不懂的旁白」），但必须标〔推导〕，且只做**修复**不做拦截 |
| 11 | `shotSize` 景别只许 5 个字面量 | 中文正文出现中文景别 / 英文出现 `a wide shot` 等 | 官方词表 **⇒ 推导** | 官方原文里**出现过**这 5 个写法，但**没有**「表外不许写」的条款 | ⚠️ 推导型。同 #10，标〔推导〕 |

**小结：11 项里 7 项有官方原句直接支撑；2 项是产品阈值；2 项（#10 #11）是「官方范例／词表 ⇒ 推导」的禁令。**
#10 #11 本身没错（都拦住了真实故障），但必须按推导型标注，且只做自动修复、不做硬拦截。

---

## 二、B 档 · 只能留在热更层的（不许写成硬闸门）

| 规则 | 为什么判不了 |
|---|---|
| 声音要跟本镜动作同步（*current sound*） | 「同步」没有可计算的边界 |
| 画面要呼应剧情、不许编造人物／场景 | 需要读懂脚本与正文 |
| 参考图内容是否被保留 | 需要看图 |
| 台词长度与该镜时长是否匹配 | 需要估算语速 |

这类**只写进 `SKILL.md`（热更）**，措辞用「建议／优先」，**不写「禁止／必须」**，
不设代码闸门。2026-10-30 的「声音必须织进动作句」正是硬塞成禁令的反面教材 ——
它与官方范例直接冲突，且没有任何机检手段，只能变成一条无法验证、无法执行的口头规则。

---

## 三、C 档 · 格式契约（代码，不可热更）

`【阶段】STEPn` 锚点、`【模式】宫格|直出`、六段段名与次序、段间空行、
`【视频提示词】` 标记 —— 前端 `src/features/chat/stageCards.ts` 与 Rust
`writer_rules/` 逐字共享，**改一侧必须同改另一侧，且必须随包发布**。
热更层永远不许携带这类契约的变更。

---

## 四、发布成本口径

| 改动类型 | 成本 |
|---|---|
| 写作规范措辞（B 档） | 传技能包，**5 分钟热更** |
| A 档闸门的阈值 | 8 个包 |
| C 档格式契约 | 8 个包 + 前端解析同步改 |

⇒ **判断一条规则该不该进代码，先问「它会不会经常变」。会变的留在 B 档。**
