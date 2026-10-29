# 2026-10-30 规则头回到官方原句（v17 → v18，服务端热更）

## 背景

`/jy/uploads/app/video_gen_rules_minimax_h3.json` 的 `prompt_rule` 是客户端在提交视频生成时**唯一**自动注入到正文前面的文本（`assembleVideoPrompt`：`${rule}\n\n${body}`）。

v17 的内容是 285 字，含两部分：

1. 一句官方英文：`<Picture 1> is a storyboard reference for every [Shot N] in this prompt, defining their viewpoint, subject placement, and shot order.`
2. 一句中文说明：`该参考图为 2×3 排列共 6 格：格 1→2→3→4→5→6 按时间顺序构成一条连续时间线……不要把整张多格图当成一个单一画面来生成。`

第 2 部分是自造内容 —— 官方 `SKILL.md` OFFICIAL_SPEC 全段（官方 §2.2 及全文）**没有任何**关于 grid / panel / cell / 2×3 / 分格 的措辞，对故事板参考图只给了一句：

> When an image acts as a storyboard or shot-planning reference, state which shots it maps to and what planning information it provides:
>
> `<Picture 3> is a storyboard reference for [Shot 1] and [Shot 2], defining their viewpoint, subject placement, and shot order.`

按铁律「提示词系统必须严格按官方，不允许任何自造」，去掉第 2 部分。

## 改动

`prompt_rule`（v17，285 字）→（v18，165 字）：

```text
<Picture 1> is a storyboard reference for [Shot 1], [Shot 2], [Shot 3], [Shot 4], [Shot 5] and [Shot 6], defining their viewpoint, subject placement, and shot order.
```

- 去掉中文说明，只留官方 §2.2 句式；`every [Shot N]` 展开为官方的枚举写法（官方允许「state which shots it maps to」）。
- 其余字段（`integration` / `negative_prompt` / `constraints` / `negative_prompt_note`）逐字未动。
- `video_gen_rules_minimax_h3_direct.json`（直出）的 `prompt_rule` 本来就是空串，不动。

## 生效范围

规则头是**服务端共用文件**，8 个产品（短视频／专业／科普／美妆／服饰／旅游／萌宠／大健康）的 `update.rs` 都取同一个 URL，上传即全部生效，**不需要客户端发版**。

## 回退与观察

- 回退：`cp video_gen_rules_minimax_h3.json.bak-20261030-officialhead video_gen_rules_minimax_h3.json`
- 待观察：宫格路是否仍按 6 格逐格出画。若实测出现「把整张 2×3 当单一画面」的退步，改用官方授权范围内的补充写法（保留官方句 + 用 `panel` 说明一格一镜的阅读顺序），仍不引入中文尾巴。

## 已知取舍

`prompt_rule` 是静态文本，无法随脚本实际镜数变化。枚举到 `[Shot 6]` 假定宫格路恒为 2×3 六格（`block_constraints.md` 第 1 条：宫格分镜图永远是 2×3 六宫格）。若某次脚本只出 5 镜，规则头会多列一镜。
