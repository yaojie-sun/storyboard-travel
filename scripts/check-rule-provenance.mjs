#!/usr/bin/env node
// 规则出处闸门：防止「我们自创的规则」冒充官方
//
// 官方语料 = SKILL.md 的 OFFICIAL_SPEC 块 + docs/official/ 下的官方参考文档
// （REFERENCE_README.en.md = 官方仓库 README 全参考改写范例，REFERENCE_base-en.txt = 官方基础字段清单）
//
// 检查 A（硬失败）：本仓区 / writer_rules / 规则头里用 *斜体英文* 引的「官方原句」，
//   必须能在官方语料里逐字命中（大小写、标点、空白归一；允许 … 截引）。
//   命中不了 = 这条「官方原句」是编的。
// 检查 B（软失败，--strict 转硬）：含 禁止/不许/不得/一律/必须 的 🔴 硬规则段，
//   必须同段带 ①官方引文 或 ②显式出处标注〔产品条款〕〔用户点名〕〔推导〕。
//
// 用法：node scripts/check-rule-provenance.mjs [treeDir] [--strict]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

const args = process.argv.slice(2);
const STRICT = args.includes('--strict');
const ROOT = args.find((a) => !a.startsWith('--')) || '.';

// 归一化成「只留字母数字与空格」的指纹：标点、大小写、markdown 记号、HTML 实体都不参与比较
const fp = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// ---- 官方语料 ----------------------------------------------------------
const skillPath = join(ROOT, 'docs/skills/SKILL.md');
if (!existsSync(skillPath)) {
  console.error(`找不到 ${skillPath}`);
  process.exit(2);
}
const skillRaw = readFileSync(skillPath, 'utf8');
const bi = skillRaw.indexOf('<!-- OFFICIAL_SPEC_BEGIN');
const ei = skillRaw.indexOf('<!-- OFFICIAL_SPEC_END');
const hasBlock = bi >= 0 && ei >= 0;

let corpus = '';
const corpusFiles = [];
if (hasBlock) {
  corpus += fp(skillRaw.slice(skillRaw.indexOf('\n', bi) + 1, ei));
  corpusFiles.push('SKILL.md (OFFICIAL_SPEC 块)');
}
const offDir = join(ROOT, 'docs/official');
if (existsSync(offDir)) {
  for (const f of readdirSync(offDir)) {
    // 台账是我们自己的文档，不是官方语料 —— 拿它当语料等于自己给自己作证
    if (/^RULES_LEDGER/i.test(f)) continue;
    corpus += ' ' + fp(readFileSync(join(offDir, f), 'utf8'));
    corpusFiles.push(f);
  }
}
if (!corpus.trim()) {
  console.error('既没有 OFFICIAL_SPEC 块，也没有 docs/official/ 官方语料，无法校验');
  process.exit(2);
}

// ---- 待检文本：本仓区（OFFICIAL_SPEC 之后）+ writer_rules + 规则头 -------
// 行业版 SKILL 没有官方块 ⇒ 整份当本仓区（官方引文在语料里，仍能命中）
const ourSkill = hasBlock ? skillRaw.slice(ei) : skillRaw;
const targets = [
  {
    file: skillPath,
    text: ourSkill,
    offsetLine: hasBlock ? skillRaw.slice(0, ei).split('\n').length : 0,
  },
];
const wrDir = join(ROOT, 'src-tauri/src/commands/writer_rules');
if (existsSync(wrDir)) {
  for (const f of readdirSync(wrDir).filter((f) => f.endsWith('.md') && !f.includes('.bak'))) {
    targets.push({ file: join(wrDir, f), text: readFileSync(join(wrDir, f), 'utf8'), offsetLine: 0 });
  }
}
for (const f of ['video_gen_rules_minimax_h3.json', 'video_gen_rules_minimax_h3_direct.json']) {
  const p = join(ROOT, 'public', f);
  if (existsSync(p)) {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    if (typeof j.prompt_rule === 'string' && j.prompt_rule.trim()) {
      targets.push({ file: p, text: j.prompt_rule, offsetLine: 0 });
    }
  }
}

// ---- 检查 A：引文校验 --------------------------------------------------
const QUOTE_RE = /\*([^*\n]{20,})\*/g;
// 官方闭集词的自由组合（运镜类型 × 幅度 × 速度）不算「自创引文」
const CLOSED_SET_RE =
  /^(?:(?:zoom|push|pull|pan|truck|tilt|pedestal|arc|tracking|static|shake|pov|roll)\s*(?:in|out|left|right|up|down|shot|clockwise|counterclockwise|slightly|strongly|in\/out)?|with\s+(?:small|large)\s+amplitude|at\s+(?:slow|fast)\s+speed|the\s+camera|camera|shot|movie|with|and|or|to|of|a|an|in|out|left|right|up|down|\W)*$/i;
const isEnglishQuote = (s) =>
  /^[\x20-\x7E\s…]*$/.test(s.replace(/[“”‘’]/g, '"')) && /[a-z]{3,}\s+[a-z]{3,}/i.test(s);

const unmatched = [];
for (const t of targets) {
  const lines = t.text.split('\n');
  // 只在「声称官方」的段落里校验引文：段落含「官方」才算它把这句话当成了官方原句
  let paraStart = 0;
  const paraOf = new Array(lines.length);
  lines.forEach((line, i) => {
    if (!line.trim()) { paraStart = i + 1; return; }
    paraOf[i] = paraStart;
  });
  const paraText = (s) => {
    let e = s;
    while (e < lines.length && lines[e].trim()) e++;
    return lines.slice(s, e).join('\n');
  };
  lines.forEach((line, i) => {
    const p = paraText(paraOf[i] ?? i);
    if (!/官方/.test(p)) return;
    for (const m of line.matchAll(QUOTE_RE)) {
      const q = m[1];
      if (!isEnglishQuote(q)) continue;
      // 不是官方引文，是「中文原句回译出来会变成什么」的反例：跳过
      if (/回译成|译成|会变成|变成\s*$/.test(line.slice(Math.max(0, m.index - 12), m.index))) continue;
      const segs = q.split(/…/).map(fp).filter((s) => s.split(' ').length >= 4);
      if (!segs.length) continue;
      if (CLOSED_SET_RE.test(q)) continue;
      const ok = segs.every((seg) => corpus.includes(seg));
      if (!ok) unmatched.push({ file: t.file, line: i + 1 + t.offsetLine, quote: q.replace(/\s+/g, ' ').slice(0, 100) });
    }
  });
}

// ---- 检查 B：硬规则出处标注 -------------------------------------------
const HARD_RE = /(禁止|不许|不得|一律|必须)/;
const hasCitation = (p) =>
  /\*[^*\n]{20,}\*/.test(p) ||
  /〔[^〕]+〕/.test(p) ||
  /官方\s*§|官方原文|官方范例|Description detail/.test(p);

const uncited = [];
for (const t of targets) {
  const lines = t.text.split('\n');
  let buf = [];
  let startLine = 0;
  const flush = () => {
    if (!buf.length) return;
    const p = buf.join('\n');
    if (p.includes('🔴') && HARD_RE.test(p) && !hasCitation(p)) {
      uncited.push({ file: t.file, line: startLine + 1 + t.offsetLine, snippet: p.replace(/\s+/g, ' ').slice(0, 110) });
    }
    buf = [];
  };
  lines.forEach((line, i) => {
    if (!line.trim()) return flush();
    if (!buf.length) startLine = i;
    buf.push(line);
  });
  flush();
}

// ---- 检查 C：闸门台账覆盖（每个机检项必须在 RULES_LEDGER 里登记出处）----
const ledgerPath = join(ROOT, 'docs/official/RULES_LEDGER.md');
const shapePath = join(ROOT, 'src/features/videoGeneration/promptShapeCheck.ts');
const unlisted = [];
if (existsSync(ledgerPath) && existsSync(shapePath)) {
  const ledger = readFileSync(ledgerPath, 'utf8');
  const src = readFileSync(shapePath, 'utf8');
  const m = src.match(/export type PromptIssueCode\s*=([\s\S]*?);/);
  if (m) {
    const codes = [...m[1].matchAll(/'([a-zA-Z]+)'/g)].map((x) => x[1]);
    for (const c of codes) if (!ledger.includes('`' + c + '`')) unlisted.push(c);
  }
}

// ---- 报告 -------------------------------------------------------------
const rel = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');
console.log(`\n规则出处闸门 · ${rel(ROOT)}`);
console.log(`官方语料：${corpusFiles.map((f) => f.split('/').pop()).join(' + ')}（指纹 ${corpus.length} 字符）`);
console.log(`检查 A 引文校验：${unmatched.length ? `❌ ${unmatched.length} 条查无此文` : '✅ 全部命中官方原文'}`);
for (const u of unmatched) console.log(`   ${rel(u.file)}:${u.line}  「${u.quote}」`);
console.log(`检查 B 出处标注：${uncited.length ? `⚠️ ${uncited.length} 段硬规则没写出处` : '✅ 全部带出处'}`);
for (const u of uncited) console.log(`   ${rel(u.file)}:${u.line}  ${u.snippet}…`);
console.log(
  `检查 C 台账覆盖：${unlisted.length ? `❌ ${unlisted.length} 项闸门没在台账登记` : '✅ 全部已登记'}` +
    (existsSync(ledgerPath) ? '' : '（无 RULES_LEDGER.md，跳过）'),
);
for (const c of unlisted) console.log(`   未登记: ${c}`);

process.exit(unmatched.length || unlisted.length || (STRICT && uncited.length) ? 1 : 0);
