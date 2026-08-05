#!/usr/bin/env node
/**
 * 同步宫格提示词规则
 * 用法: node scripts/sync-grid-rules.mjs
 *
 * 流程:
 *   1. 读取 grid_prompt_rules.json 并验证
 *   2. 同步到 gridPromptRules.ts 的 DEFAULT_RULES
 *   3. 上传到服务器
 *   4. TS 类型检查
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const RULES_JSON_PATH = resolve(ROOT, 'grid_prompt_rules.json');
const TS_MODULE_PATH = resolve(ROOT, 'src/features/canvas/application/gridPromptRules.ts');
const SERVER = 'root@47.108.237.10';
const SSH_KEY = resolve(ROOT, 'jiaoyan.pem');
const SERVER_PATH = '/jy/uploads/app/grid_prompt_rules_shortvideo.json';

function log(msg) {
  console.log(`[sync-grid-rules] ${msg}`);
}

function fail(msg) {
  console.error(`[sync-grid-rules] ERROR: ${msg}`);
  process.exit(1);
}

// ---- Step 1: Read & validate JSON ----
log('Reading grid_prompt_rules.json...');
let rules;
try {
  rules = JSON.parse(readFileSync(RULES_JSON_PATH, 'utf-8'));
} catch (err) {
  fail(`Cannot parse JSON: ${err.message}`);
}

if (!rules.version || !rules.grid_prompt) {
  fail('Missing required fields: version, grid_prompt');
}

const required = [
  'global_header', 'identity_lock', 'scene_lock', 'camera_style',
  'sequence_context', 'frame_title_template', 'frame_fields',
  'frame_field_labels', 'hard_constraints',
];
for (const key of required) {
  if (!rules.grid_prompt[key]) {
    fail(`Missing grid_prompt.${key}`);
  }
}

log(`JSON valid, version=${rules.version}`);

// ---- Step 2: Sync to TypeScript DEFAULT_RULES ----
log('Syncing DEFAULT_RULES in gridPromptRules.ts...');

let tsContent = readFileSync(TS_MODULE_PATH, 'utf-8');

// Find and replace the DEFAULT_RULES block
const defaultRulesStart = tsContent.indexOf('const DEFAULT_RULES: GridPromptRules = {');
if (defaultRulesStart === -1) fail('Cannot find DEFAULT_RULES in gridPromptRules.ts');

// Find the matching closing brace
let depth = 0;
let defaultRulesEnd = -1;
for (let i = tsContent.indexOf('{', defaultRulesStart); i < tsContent.length; i++) {
  if (tsContent[i] === '{') depth++;
  else if (tsContent[i] === '}') {
    depth--;
    if (depth === 0) {
      defaultRulesEnd = i + 1;
      // Consume trailing semicolon if present
      if (tsContent[defaultRulesEnd] === ';') defaultRulesEnd++;
      break;
    }
  }
}
if (defaultRulesEnd === -1) fail('Cannot find end of DEFAULT_RULES');

// Build the new DEFAULT_RULES
const indent = '  ';
const rulesJson = rules.grid_prompt;

function quote(s) { return `'${s.replace(/'/g, "\\'")}'`; }
function indentLines(text, level) {
  const pad = indent.repeat(level);
  return text.split('\n').map(l => pad + l).join('\n');
}

const lines = [];
lines.push('const DEFAULT_RULES: GridPromptRules = {');
lines.push(`${indent}version: ${quote(rules.version)},`);
lines.push(`${indent}grid_prompt: {`);

// Simple string fields
const stringFields = [
  'global_header', 'section_identity_lock', 'identity_lock',
  'section_scene_lock', 'scene_lock', 'section_camera', 'camera_style',
  'section_sequence', 'sequence_context', 'section_visual_carryover',
  'section_reference_priority', 'reference_image_priority', 'section_frames',
  'frame_title_template', 'frame_default_shot', 'frame_default_emotion',
  'frame_default_facing', 'frame_field_source_auto', 'frame_field_source_user',
  'frame_ref_image_instruction', 'section_layout', 'layout_strictness',
  'section_hard_constraints',
  'action_continuity_fallback', 'facing_inference_rule',
  'style_consistent_text', 'disable_text_in_image_text',
];

for (const key of stringFields) {
  if (rulesJson[key] !== undefined) {
    lines.push(`${indent}${indent}${key}:`);
    const value = rulesJson[key];
    if (value.includes('\n')) {
      // Multi-line string
      const escaped = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      lines.push(`${indent}${indent}${indent}${quote(escaped)},`);
    } else {
      lines.push(`${indent}${indent}${indent}${quote(value)},`);
    }
  }
}

// frame_fields array
if (Array.isArray(rulesJson.frame_fields)) {
  lines.push(`${indent}${indent}frame_fields: [${rulesJson.frame_fields.map(quote).join(', ')}],`);
}

// frame_field_labels object
if (rulesJson.frame_field_labels) {
  lines.push(`${indent}${indent}frame_field_labels: {`);
  for (const [k, v] of Object.entries(rulesJson.frame_field_labels)) {
    lines.push(`${indent}${indent}${indent}${k}: ${quote(v)},`);
  }
  lines.push(`${indent}${indent}},`);
}

// hard_constraints array
if (Array.isArray(rulesJson.hard_constraints)) {
  lines.push(`${indent}${indent}hard_constraints: [`);
  for (const item of rulesJson.hard_constraints) {
    lines.push(`${indent}${indent}${indent}${quote(item)},`);
  }
  lines.push(`${indent}${indent}],`);
}

// visual_identity_carryover array
if (Array.isArray(rulesJson.visual_identity_carryover)) {
  lines.push(`${indent}${indent}visual_identity_carryover: [`);
  for (const item of rulesJson.visual_identity_carryover) {
    lines.push(`${indent}${indent}${indent}${quote(item)},`);
  }
  lines.push(`${indent}${indent}],`);
}

lines.push(`${indent}},`);
lines.push('};');

const newDefaultRules = lines.join('\n');

const before = tsContent.slice(0, defaultRulesStart);
const after = tsContent.slice(defaultRulesEnd);
tsContent = before + newDefaultRules + after;

writeFileSync(TS_MODULE_PATH, tsContent, 'utf-8');
log('DEFAULT_RULES synced.');

// ---- Step 3: Upload to server ----
log('Uploading to server...');
try {
  execSync(
    `scp -i "${SSH_KEY}" "${RULES_JSON_PATH}" ${SERVER}:${SERVER_PATH}`,
    { stdio: 'inherit', cwd: ROOT }
  );
  log('Uploaded successfully.');
} catch (err) {
  fail(`SCP upload failed: ${err.message}`);
}

// Verify server file
try {
  const result = execSync(
    `ssh -i "${SSH_KEY}" ${SERVER} "python3 -m json.tool ${SERVER_PATH} > /dev/null && echo OK || echo INVALID"`,
    { encoding: 'utf-8', cwd: ROOT }
  );
  if (result.trim() === 'OK') {
    log('Server JSON validated.');
  } else {
    fail('Server JSON is invalid after upload!');
  }
} catch (err) {
  fail(`Server verification failed: ${err.message}`);
}

// ---- Step 4: TypeScript check ----
log('Running tsc --noEmit...');
try {
  execSync('npx tsc --noEmit', { stdio: 'inherit', cwd: ROOT });
  log('TypeScript check passed.');
} catch (err) {
  fail('TypeScript check failed. Fix errors before proceeding.');
}

log('');
log('========================================');
log(`  Grid rules v${rules.version} synced & deployed`);
log('  Server:  http://47.108.237.10/jy/uploads/app/grid_prompt_rules_shortvideo.json');
log('  No client update needed — rules are fetched on demand');
log('========================================');
