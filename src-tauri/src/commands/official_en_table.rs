//! 官方英文对照表 —— 英文闸门里所有「形式字面量」的唯一来源。
//!
//! 每一行都是 **(错误写法 ⇒ 官方写法)** 的一对一替换：不合规就**直接按表走**，
//! 不叫模型、不猜语义。`right` 一侧逐字取自官方语料（`npm run check:rules` 检查 A
//! 会拿 `docs/official/` 逐字比对，查无此文 = 表项不许落地）。
//!
//! 🔴 进表三条门槛（全满足才许加）：
//! 1. **唯一**：官方只给了一种写法（`with small / large amplitude` 这种多选题不进表）；
//! 2. **无语境**：替换只修形式差异（冠词、物主代词、连字符、介词），不改意思；
//! 3. **有出处**：官方写法能在 `docs/official/` 里逐字找到。
//!
//! 🔴 语义映射不许进表：`a wide shot` 该改判 `a medium-wide shot` 还是 `a medium shot`
//!    取决于画面，代码不许替用户决定 —— 那类只能做成缺陷清单递回模型原地改
//!    （见 `prompt_repair::check_shot_size_vocabulary`）。
//!
//! 用法：`official_en_table::apply(text)`，幂等（改完再跑一遍结果不变）。

/// 一条一对一替换。
pub struct LiteralFix {
    /// 常见不合规写法（小写比对，大小写不敏感）
    pub wrong: &'static str,
    /// 官方写法（逐字）
    pub right: &'static str,
    /// 只在**同一行**含这个提示词时才替换；`""` = 全文可换。
    /// 用来防止短词误伤正常散文（例如 `defining the viewpoint` 只在水印声明句里修）。
    pub scope: &'static str,
    /// 出处（官方 §号 / 原句要点），只给维护者看
    pub source: &'static str,
}

pub const LITERAL_FIXES: &[LiteralFix] = &[
    // ── §2.2 `<Picture N>` 故事板声明 ───────────────────────────────────────
    // 官方：`<Picture 3> is a storyboard reference for [Shot 1] and [Shot 2],
    //        defining their viewpoint, subject placement, and shot order.`
    LiteralFix {
        wrong: "is the storyboard reference",
        right: "is a storyboard reference",
        scope: "storyboard reference",
        source: "OFFICIAL_SPEC §2.2",
    },
    LiteralFix {
        wrong: "defining the viewpoint",
        right: "defining their viewpoint",
        scope: "storyboard reference",
        source: "OFFICIAL_SPEC §2.2",
    },
    // 官方 Picture 角色闭集：first frame / keyframe / last frame / edited keyframe /
    // composition anchor —— 不许自造 `spatial and compositional …` 这类角色名
    LiteralFix {
        wrong: "spatial and compositional anchor",
        right: "composition anchor",
        scope: "",
        source: "OFFICIAL_SPEC §2.2 角色闭集",
    },
    LiteralFix {
        wrong: "spatial and compositional benchmark",
        right: "composition anchor",
        scope: "",
        source: "OFFICIAL_SPEC §2.2 角色闭集",
    },
    LiteralFix {
        wrong: "spatial and compositional reference",
        right: "composition anchor",
        scope: "",
        source: "OFFICIAL_SPEC §2.2 角色闭集",
    },
    // ── §4.4 画外音固定短语 ──────────────────────────────────────────────────
    // 官方：`says in an off-screen voiceover`
    LiteralFix {
        wrong: "offscreen voiceover",
        right: "off-screen voiceover",
        scope: "",
        source: "OFFICIAL_SPEC §4.4",
    },
    LiteralFix {
        wrong: "off screen voiceover",
        right: "off-screen voiceover",
        scope: "",
        source: "OFFICIAL_SPEC §4.4",
    },
    LiteralFix {
        wrong: "off-screen voice-over",
        right: "off-screen voiceover",
        scope: "",
        source: "OFFICIAL_SPEC §4.4",
    },
    LiteralFix {
        wrong: "off screen voice-over",
        right: "off-screen voiceover",
        scope: "",
        source: "OFFICIAL_SPEC §4.4",
    },
    // ── 口型句固定短语 ──────────────────────────────────────────────────────
    // 官方范例：`mouth movements naturally syncing to the new dialogue`
    LiteralFix {
        wrong: "mouth movements naturally syncing with the new dialogue",
        right: "mouth movements naturally syncing to the new dialogue",
        scope: "",
        source: "REFERENCE_README 官方范例",
    },
];

/// 按表直换（大小写不敏感，保留 `right` 的原始大小写）。
///
/// 幂等：`right` 里不含 `wrong`，所以再跑一遍不会再变。
pub fn apply(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for (i, line) in text.split('\n').enumerate() {
        if i > 0 {
            out.push('\n');
        }
        out.push_str(&fix_line(line));
    }
    out
}

fn fix_line(line: &str) -> String {
    let mut cur = line.to_string();
    for fix in LITERAL_FIXES {
        if !fix.scope.is_empty() && !contains_ci(&cur, fix.scope) {
            continue;
        }
        cur = replace_ci(&cur, fix.wrong, fix.right);
    }
    cur
}

fn contains_ci(haystack: &str, needle: &str) -> bool {
    haystack.to_lowercase().contains(&needle.to_lowercase())
}

/// 大小写不敏感替换；命中处直接换成 `to` 的原文大小写。
fn replace_ci(haystack: &str, from: &str, to: &str) -> String {
    let lower = haystack.to_lowercase();
    let needle = from.to_lowercase();
    if !lower.contains(&needle) {
        return haystack.to_string();
    }
    let mut out = String::with_capacity(haystack.len() + 8);
    let mut rest = haystack;
    let mut rest_lower = lower.as_str();
    while let Some(pos) = rest_lower.find(&needle) {
        out.push_str(&rest[..pos]);
        out.push_str(to);
        rest = &rest[pos + needle.len()..];
        rest_lower = &rest_lower[pos + needle.len()..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixes_storyboard_declaration() {
        let src = "<Picture 3> is the storyboard reference for [Shot 1] and [Shot 2], defining the viewpoint, subject placement, and shot order.";
        let out = apply(src);
        assert_eq!(
            out,
            "<Picture 3> is a storyboard reference for [Shot 1] and [Shot 2], defining their viewpoint, subject placement, and shot order."
        );
    }

    #[test]
    fn leaves_clean_text_untouched() {
        let src = "<Picture 3> is a storyboard reference for [Shot 1], defining their viewpoint, subject placement, and shot order.";
        assert_eq!(apply(src), src);
    }

    #[test]
    fn does_not_touch_defining_the_viewpoint_outside_declaration() {
        let src = "The camera defines the viewpoint of the room.";
        assert_eq!(apply(src), src);
    }

    #[test]
    fn normalizes_voiceover_spelling() {
        assert_eq!(
            apply("The man (S1) says in an offscreen voiceover"),
            "The man (S1) says in an off-screen voiceover"
        );
        assert_eq!(
            apply("The man (S1) says in an off-screen voice-over"),
            "The man (S1) says in an off-screen voiceover"
        );
    }

    #[test]
    fn is_idempotent() {
        let src = "<Picture 3> is the storyboard reference, defining the viewpoint; says in an offscreen voiceover.";
        let once = apply(src);
        assert_eq!(apply(&once), once);
    }
}
