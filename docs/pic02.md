# pic02 — 读图换成 DeepSeek 视觉模型 + 图像大小限制（只读一次）

> 复刻文档：本次改动为**行业无关**的公共读图逻辑，所有行业版本（服饰/美妆/科普/大健康/萌宠等）完全一致，可直接照抄。
> 改动基准版本：旅游版 v1.2.0。改动日期：2026-08-22。

## 一、动机（为什么改）

- **旧链路**：读图用千帆 `ERNIE-VL`（`ernie-4.5-turbo-vl`），`normalize_for_vl` 对 JPEG/PNG/BMP **原样透传、零压缩**。4MB 大图 → base64 ~5.3MB 塞进请求体 → 千帆处理慢/超时 → 读图失败 → `asset_descriptions` 缓存写不进去 → **每次进画布都重读一遍**，6 张图卡 10-20 秒。
- **新链路**：读图换 `deepseek-v4-flash-vision-exp`（DeepSeek 视觉模型），读图前**统一下采样**（最长边 ≤ 1024、重编码 JPEG q85），单张 ~100-200KB 秒回。读一次写入 `asset_descriptions`（file_hash 缓存），后续进画布命中缓存，**不再重读**。

## 二、改动文件（共 2 个，后端）

### 1. `src-tauri/src/ai/describe.rs`（整体重写读图逻辑）

| 项 | 旧值 | 新值 |
|---|---|---|
| 端点 | `https://qianfan.baidubce.com/v2/chat/completions` | `https://api.deepseek.com/chat/completions` |
| 模型 | `ernie-4.5-turbo-vl` | `deepseek-v4-flash-vision-exp` |
| `normalize_for_vl` | JPEG/PNG/BMP 原样透传，WebP/GIF 转 PNG | **统一解码 + 下采样到最长边 1024 + 重编码 JPEG q85**（`resize_exact` + `Lanczos3`） |
| 鉴权 | `Bearer <千帆 key>` | `Bearer <DeepSeek key>`（格式不变） |
| 请求体 | OpenAI 兼容 `content[]` 数组（text + image_url） | **不变** |

新增常量：
```rust
const MAX_EDGE: u32 = 1024;   // 下采样最长边
const JPEG_QUALITY: u8 = 85;  // JPEG 质量
```

下采样核心（照抄 `src/ai/providers/minimax/mod.rs` 的既有写法，同一套 image 0.25 API）：
```rust
let img = image::load_from_memory(image_bytes)?;
let (w, h) = (img.width(), img.height());
let (nw, nh) = if w.max(h) > MAX_EDGE {
    let s = MAX_EDGE as f64 / (w.max(h) as f64);
    (((w as f64)*s).round().max(1.0) as u32, ((h as f64)*s).round().max(1.0) as u32)
} else { (w, h) };
let rgb = img.resize_exact(nw, nh, image::imageops::FilterType::Lanczos3).to_rgb8();
let mut buf = std::io::Cursor::new(Vec::new());
let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, JPEG_QUALITY);
enc.encode_image(&rgb)?;
// 返回 (buf.into_inner(), "image/jpeg")
```

### 2. `src-tauri/src/commands/asset.rs`（2 处小改）

**A. 读图密钥来源**（`describe_asset_inner` 开头）：
```rust
// 旧
let api_key = crate::commands::banana_api::get_qianfan_vl_key()
    .ok_or_else(|| "千帆VL读图API密钥未配置".to_string())?;
// 新
let api_key = crate::commands::banana_api::get_deepseek_chat_key()
    .ok_or_else(|| "DeepSeek视觉读图API密钥未配置".to_string())?;
```

**B. 缓存表里记录的模型名**（写缓存那行）：
```rust
// 旧
params![asset_id, file_hash, description, "ernie-4.5-turbo-vl", now],
// 新
params![asset_id, file_hash, description, "deepseek-v4-flash-vision-exp", now],
```

（同时把 `describe_asset_inner` 上方注释里的「调千帆 VL」改成「调 DeepSeek 视觉模型」，纯注释。）

## 三、缓存机制（不变，无需动）

- 读图结果写入 SQLite `asset_descriptions` 表，主键 `asset_id`，命中条件 `asset_id + file_hash`（`md5`）。
- `add_asset` 上传时后台异步读图（`tauri::async_runtime::spawn`）；前端 `describe_asset` / `buildAssetReferenceLines` 用 `get_asset_descriptions` 先查缓存，命中不读。
- `IN_FLIGHT_DESCRIBES`（`TokioOnceCell`）做并发合并，同一图只读一次、不重复扣费。
- 这套缓存逻辑在 `asset.rs` 中**原样保留**，本次只换了读图模型，缓存语义没变。

## 四、复刻到其他版本（照抄步骤）

1. 把新 `describe.rs` 整文件覆盖到目标版本 `src-tauri/src/ai/describe.rs`（本文件行业无关，直接覆盖）。
2. 目标版本 `src-tauri/src/commands/asset.rs` 里：
   - `get_qianfan_vl_key()` → `get_deepseek_chat_key()`；
   - 写缓存那行 `"ernie-4.5-turbo-vl"` → `"deepseek-v4-flash-vision-exp"`。
3. `cargo check` 通过即可，前端**零改动**（`describeAsset` / `getAssetDescriptions` 命令签名没变）。

## 五、关键坑（务必注意）

1. **密钥来源**：读图用的是 `get_deepseek_chat_key()`（服务器 `/api-configs/active` 下发类型 `DEEPSEEK_CHAT`/`deepseek` 的密钥），**不是** `get_user_api_key()`（那是网关 token）。`banana_api.rs` 里 `DEEPSEEK_CHAT` 分支已存在，无需改。
2. **服务端依赖**：端到端生效要求服务器 `/api-configs/active` 必须下发一个有效的 **DeepSeek API Key**（类型 `DEEPSEEK_CHAT`），且该 key 具备 `deepseek-v4-flash-vision-exp` 视觉模型访问权限。客户端代码已就绪，若服务器未配该 key，读图会报「DeepSeek视觉读图API密钥未配置」。
3. **下采样必须做**：不压缩直接 base64 大图，DeepSeek 视觉接口同样会慢/超时，缓存写不进去，问题复发。
4. **`qianfan_vl` 旧密钥路径可保留**：`banana_api.rs` 里 `QIANFAN_VL_KEY` 的 getter/setter/映射已无调用方，留着无害（`pub fn` 不触发 dead_code 警告），不必删，避免动服务器配置解析逻辑。
5. **请求体结构不变**：DeepSeek 视觉与千帆都是 OpenAI 兼容 `messages[].content[]`（text + image_url），所以只换 URL/模型/key 即可，`describe_image` 主体几乎不动。

## 六、验证清单

1. `cd src-tauri && cargo check` 通过（无新增告警）。
2. 上传 6 张 4MB 参考图 → 首次后台读图成功 → 日志出现 `[读图] DeepSeek视觉请求` / `DeepSeek视觉完成`。
3. 进画布（进入画布）命中缓存，**秒回**，不再 10-20 秒；日志不再出现重复读图。
4. 读图描述正常注入 `@图N 视觉描述`，分镜/宫格生成不受影响。

---

## 七、上传自动压缩（大图落盘前下采样，2026-08-22 补充）

### 动机

读图下采样只解决了「读图」慢，但**宫格/画布直接用 `asset.filePath`（原图）加载**，4MB×6 张照样导致「进入画布」慢几秒。用户要求**不限制上传**（不做 5MB 拒绝），而是**检测到大图先压缩再落盘**，让用户无感。

### 规则（双触发）

| 触发条件 | 动作 |
|---|---|
| 最长边 > 2048px | 下采样到最长边 2048 + 重编码 JPEG q88 |
| 体积 > 5MB | 同上（兜底，防小尺寸大体积的 PNG/BMP） |
| 两者都不满足 | 原样透传，不动格式与画质 |

> 注意阈值选择：用户图片普遍 ~4MB（长边 3000~6000px），若只按「>5MB」压缩则这批图不会被压、卡顿不解决；所以**主触发用分辨率（最长边 >2048）**，5MB 仅兜底。

### 改动文件（2 处，均为后端）

**1. `src-tauri/src/ai/describe.rs`** 新增（`normalize_for_vl` 之后、`describe_image` 之前）：

```rust
pub enum UploadImage { Original(Vec<u8>), CompressedJpeg(Vec<u8>) }

pub fn compress_for_upload(image_bytes: &[u8]) -> Result<UploadImage, AIError> {
    const UPLOAD_MAX_EDGE: u32 = 2048;
    const UPLOAD_MAX_BYTES: usize = 5 * 1024 * 1024;
    const UPLOAD_JPEG_QUALITY: u8 = 88;
    // load_from_memory 解码 → 小图返回 Original(原字节)
    // → 大图 resize_exact(2048, Lanczos3) + JpegEncoder q88 → CompressedJpeg
}
```

**2. `src-tauri/src/commands/asset.rs`** — `add_asset` 里 `std::fs::copy` 改为「读源 → 压缩 → 写盘」：

```rust
let src_bytes = std::fs::read(&source_path)?;
let (out_bytes, out_ext) = match crate::ai::describe::compress_for_upload(&src_bytes) {
    Ok(UploadImage::Original(b)) => (b, ext.to_string()),
    Ok(UploadImage::CompressedJpeg(b)) => (b, "jpg".to_string()),   // 压缩后扩展名改 jpg
    Err(_) => (src_bytes, ext.to_string()),                        // 解码失败原样兜底
};
let dest_path = assets_dir.join(format!("{}-{}.{}", id, &file_name, out_ext));
std::fs::write(&dest_path, &out_bytes)?;
```

（同时 `use tracing::warn` → `use tracing::{info, warn}`，压缩成功打一行 `info!` 日志。）

### 复刻到其他版本

1. 覆盖 `describe.rs`（本文件已含 `compress_for_upload`）。
2. `asset.rs` 的 `add_asset` 按上面把 `copy` 换成「读→压→写」，并加 `info` 到 tracing 导入。
3. 其余版本若无 `asset_descriptions` 缓存，只需改 `add_asset` 落盘逻辑即可（压缩与读图缓存相互独立）。

### 关键坑

1. **压缩会改扩展名为 jpg**（PNG/BMP 大图 → jpg），`dest_path` 必须用 `out_ext` 重算，不能沿用源扩展名，否则 jpg 字节挂 .png 名。
2. **解码失败必须兜底原样保存**，不能因为压缩失败阻塞上传。
3. **小图别重编码**：`Original` 分支直接返回原字节，保证小图零画质损失、字节一致。
4. 压缩在**上传落盘时**做一次（幂等），后续读图 `normalize_for_vl` 再 2048→1024 只做小幅二次缩小，无影响。

---

## 八、读图时机从「上传时」挪到「生成时」（2026-08-22 补充）

### 动机

用户上传参考图后，旧代码在 `add_asset` 里 `tauri::async_runtime::spawn` **后台自动读图**。这是逻辑错误：用户可能传错图、或上传后又修改/替换图，上传时读的可能是**错误或过时的图**。正确时机是**用户触发「生成分镜提示词」时**——此时读的才是用户最终确认的图。同时，这也为「从脚本挑参考图自动连线」（下一步）打基础：模型要在发脚本那一刻拿到所有参考图描述。

### 新读图时机

```
上传(只存+压缩, 不读) → 进画布(不读) → 用户发脚本生成分镜 → 生成时补读缺失描述(只读一次, 缓存复用) → 生成
```

### 改动文件（4 处：1 后端 + 3 前端）

**1. `src-tauri/src/commands/asset.rs`** — 删除 `add_asset` 末尾的后台读图 spawn：
```rust
// 删除这整块
let app_for_desc = app.clone();
let asset_id_for_desc = record.id.clone();
tauri::async_runtime::spawn(async move {
    if let Err(e) = describe_asset_inner(&app_for_desc, &asset_id_for_desc).await {
        warn!("asset {} 读图失败: {}", asset_id_for_desc, e);
    }
});
```
`describe_asset_inner` 及其缓存（file_hash / `IN_FLIGHT_DESCRIBES`）**原样保留**，只删掉上传时的自动触发；`describe_asset` 命令仍在，供前端生成时显式调用。删除后 `warn` 导入撤回：`use tracing::{info, warn}` → `use tracing::info`。

**2. `src/commands/asset.ts`** — `buildAssetReferenceLines` 加 `readIfMissing` 开关（默认 false 不读）：
```ts
export async function buildAssetReferenceLines(
  projectId: string,
  opts?: { readIfMissing?: boolean },
): Promise<string[]> {
  const readIfMissing = opts?.readIfMissing ?? false;   // 默认不读，只在生成时显式读
  // ...
  if (readIfMissing) {                                  // 补读缺失描述块包进 if
    const missing = assets.filter((a) => !descMap.has(a.id));
    if (missing.length > 0) {
      await Promise.allSettled(missing.map((a) => describeAsset(a.id).catch(() => null)));
    }
    const refreshed = await getAssetDescriptions(projectId).catch(() => []);
    refreshed.forEach((d) => descMap.set(d.assetId, d.description));
  }
}
```

**3. `src/features/chat/projectContext.ts`** — `buildProjectChatContext` 加同名 `opts` 透传给 `buildAssetReferenceLines`。

**4. `src/stores/chatStore.ts`** — `sendMessage` 在 `chatSendMessage` 前补读（失败不阻塞）：
```ts
import { buildProjectChatContext } from '@/features/chat/projectContext';
// ...
try {
  let context = projectContext;
  try {
    const fresh = await buildProjectChatContext(get().currentProjectId, { readIfMissing: true });
    if (fresh) context = fresh;
  } catch { /* 读图失败不阻塞生成 */ }
  const response = await chatSendMessage(buildMessages(updatedConversation), context || undefined, billingTag);
}
```

### 复刻到其他版本

1. `asset.rs` 删除 `add_asset` 后台读图 spawn + `warn` 导入撤回。
2. 前端 3 处照抄上面（asset.ts / projectContext.ts / chatStore.ts）。
3. 其余调用点（Dashboard / Canvas / ReanalyzeDialog / ChatInput 上传后）**无需改**：它们调 `buildProjectChatContext(projectId)` 不带 opts，自动落到默认「不读」。

### 关键坑

1. **默认 false 是关键**：`readIfMissing` 默认不读，只有 `sendMessage` 显式传 true。这样 canvas 入口 / 上传后 / 重新分析这些既有调用点自动「不读图」，无需逐个改。
2. **缓存语义不变**：生成时补读走 `describe_asset_inner`，file_hash 命中秒回；同一图只读一次、后续 send 全部命中缓存，不重复扣费。
3. **读图失败不阻塞生成**：补读包在 `try/catch` 里，读图挂了（key 缺失/网络）也照常发消息，只是参考图描述缺失。
4. **`describe_asset_inner` 别删**：它同时被 `describe_asset` 命令和（旧）spawn 引用，删 spawn 只删调用点，函数本体与缓存必须保留。

---

## 九、宫格节点自动连线：从「最新6张」改为「AI 挑图」（2026-08-22 补充）

### 动机

已有功能：用户点「生成宫格图」→ `FillGridButtons` 发 `chat-fill-grid` 事件 → `Canvas.handleChatFillGrid` 自动建宫格节点 + 把**最近上传的 6 张**参考图建 upload 节点并连线。问题：一条视频通常只用其中几张，硬塞最新 6 张会混入无关图。改为：**让 AI 从脚本挑出最相关的 ≤6 张**，其余逻辑复用。

### 机制（不改连线，只换「选图来源」）

1. **让模型输出选图**（`src/features/chat/projectContext.ts`）：项目上下文追加一句，指示模型「结合脚本判断最相关参考图（≤6），单独输出一行 `【选图】@图N,@图M,...`」。
2. **解析选图**（`src/stores/chatStore.ts`）：
   - `PromptBlock` 加 `selectedRefImages?: number[]`（1-based `@图N`）。
   - 新增 `parseSelectedRefImages`（正则抓 `【选图】` 行 → 去重 → 截断 6 → `number[]`）。
   - `parsePromptBlocks` 开头解析并 `replace` 剥离 `【选图】` 行（避免污染 grid content），把结果挂到 grid block 上（主分支 + fallback 分支两处）。
3. **透传**：`EditablePromptBlock` → `FillGridButtons`（加 `selectedRefImages` prop）→ `chat-fill-grid` 事件 detail 加 `selectedRefImages`。
4. **画布用 AI 选图**（`src/features/canvas/Canvas.tsx` `handleChatFillGrid`）：
   - detail 类型加 `selectedRefImages?: number[]`。
   - `matchedAssets`：有 `selectedRefImages` 时按 `allAssets[n-1]` 取对应资产（`allAssets` = `getAssets(projectId)` 按 `createdAt` 倒序）；否则回退「最新 6 张」。

### 关键坑

1. **`@图N` 编号 = 1-based**：项目上下文里 `@图${i+1}` 对应 `listAssets`（`ORDER BY created_at DESC`）第 i 个；画布侧 `allAssets` 也按 `createdAt` 倒序，故 `@图N` → `allAssets[N-1]`。**两端排序必须一致**（都按 createdAt 倒序），否则选错图。
2. **`【选图】` 行必须剥离**：不剥离会把 `【选图】@图1,@图3` 混进 grid `content`，污染宫格提示词。剥离用 `content.replace(/【选图】[^\n【]*\n?/g, '')`。
3. **fallback 兜底**：模型没输出 `【选图】`（或解析失败）时，回退到原「最新 6 张」逻辑，不破坏旧行为。
4. **上限 6**：解析端 `.slice(0,6)` + 画布端 `slice(0, MAX_AUTO_REF_IMAGES)` 双重兜底。
5. **SKILL.md 建议同步**：`【选图】` 指令目前加在 projectContext（前端即时生效）；若要更稳定，SKILL.md 的输出格式规则里也应补一句 `【选图】`（需重新 zip + 上传热更）。（注：v1.2.2 已补入 SKILL.md，v1.2.3 又收紧，见 §十一。）

---

## 十、网关分镜/优化模型统一切到 vision-exp（服务器一次性，所有行业版本共享）

### 动机

分镜提示词 / 故事分析 / 提示词优化三个请求走网关，代码里写 `CHAT_MODEL="claude-sonnet-4-6"` 只是**路由/扣费标识**，真实模型落点在**数据库**。本次把落点模型从 `deepseek-v4-pro` 换成 `deepseek-v4-flash-vision-exp`——更便宜，纯文本提示词生成质量不降。

### 落点（关键：不是代码字典）

网关 `/jy/backend/app/api/endpoints/gateway.py` 的 `map_anthropic_model()` **优先读数据库** `api_configs` 表里 `is_active=1` 的文本配置的 `additional_params.model_name`。代码里的 `ANTHROPIC_MODEL_MAP`（gateway.py:912 `"claude-sonnet-4-6": "deepseek-v4-flash"`）是**死代码**——被 DB 覆盖，改它不生效。

改法（服务器一次性，已做）：

```bash
# 1. 备份
cp /jy/data/banana.db /jy/data/banana.db.bak.20260822_pre_vision_swap
# 2. 改唯一激活文本配置 id 24 的 model_name
sqlite3 /jy/data/banana.db \
  "UPDATE api_configs SET additional_params = json_set(additional_params, '\$.model_name', 'deepseek-v4-flash-vision-exp') WHERE id = 24;"
```

### 复刻到其他版本

**无需逐版本改**。网关是共享的，DB 改一次，全行业版本同时生效。客户端 `CHAT_MODEL` / `ANALYSIS_MODEL` / `OPTIMIZE_MODEL` 字符串**不用动**（只是路由/扣费标识）。

### 关键坑

1. **别改代码字典** `ANTHROPIC_MODEL_MAP`——被 DB 覆盖，改了是无效改动。
2. `deepseek-v4-flash-vision-exp` 是**推理模型**：响应同时带 `reasoning_content`（思考）+ `content`（答案），`max_tokens` **两个都计入**。`max_tokens` 压太低（<4096）会让思考吃光额度、`content` 返回空。生产 `additional_params.max_tokens=8192` 正常；任何地方复用该模型别把 max_tokens 压太低。
3. 网关仍纯文本进/出，图片被转成 `[图像内容]` 占位符，所以 vision 模型走网关「看不见」图，分镜仍是纯文本生成——这是预期，不是 bug。

---

## 十一、选图过度修复（v1.2.3）：只选本段脚本真实出现的场景

### 动机

AI 挑图上线（v1.2.2）后发现「选图过度」：脚本只拍酒店外观+大门，但 `【选图】` 把洗衣房/健身房/走廊/房间/餐厅这些**同项目但脚本没出现**的场景也选进去了，导致宫格连线了无关参考图。

### 根因

`【选图】` 指令写「最相关、最多6张」，模型把「最多6张」当成「尽量选满6张」，于是塞入无关场景。

### 改动文件（2 处，同一句收紧）

| 文件 | 旧 | 新 |
|---|---|---|
| `src/features/chat/projectContext.ts`（line 44） | 最相关、最有助于画面生成（最多6张） | 只列本段脚本/分镜中**真实出现其场景**的图，未涉及的一律不选（宁缺毋滥） |
| `docs/skills/SKILL.md`（line 344） | 同上 | 同上 + 举例「只拍外观与大门时，健身房/洗衣房/餐厅/房间/走廊都不要选」 |

同步：SKILL `version=1.2.2 → 1.2.3`，`SECURITY_MARKER` 一起改，`version.txt` changelog 加一条；重新 zip（SKILL.md + version.txt 平铺）+ 上传热更：

```bash
# 本地重打 zip（docs/skills 下，flat 打包）
python -c "import zipfile; z=zipfile.ZipFile('xiaoya-ai-cinema-travel.zip','w',zipfile.ZIP_DEFLATED); z.write('SKILL.md','SKILL.md'); z.write('version.txt','version.txt'); z.close()"
# 上传
scp -i "$HOME/jiaoyan.pem" version.txt root@47.108.237.10:/jy/uploads/install_guide/files/version_travel.txt
scp -i "$HOME/jiaoyan.pem" xiaoya-ai-cinema-travel.zip root@47.108.237.10:/jy/uploads/install_guide/files/
```

### 复刻到其他版本

1. `projectContext.ts` 那句 `【选图】` 指令**照抄新措辞**（「只列本段脚本/分镜中真实出现其场景的参考图编号，脚本未涉及的一律不选」）。
2. 目标版本 SKILL.md 对应 `【选图】` 规则行照抄新措辞 + version.txt 版本号递增 + 重新 zip + scp 上传（文件名换成目标版本的 `version_xxx.txt` / `xiaoya-ai-cinema-xxx.zip`）。

### 关键坑

1. **措辞核心是「宁缺毋滥」**：强调「未涉及的一律不选」，而不是「最多6张」。否则模型会把 6 张当成目标值去塞满。
2. **两处必须一起改**：projectContext（前端即时生效）+ SKILL.md（系统提示词，需热更）。只改一处，另一处仍是旧措辞，可能复发。

---

## 十二、视频生成后本地超分文案（用户可见）

### 动机

视频生成后自动本地超分到 2K，进度蒙版文案写「正在本地超分到2K...」，把「超分」实现细节暴露给用户，不友好。改成面向结果的说法。

### 改动文件（1 处，纯文案）

`src/features/videoGeneration/VideoGenDialog.tsx`（line 1160）：`正在本地超分到2K...` → `正在生成2K视频...`。

### 复刻到其他版本

目标版本 `VideoGenDialog.tsx` 找到该行照抄替换即可。**只改用户可见文案**，代码注释/变量名里的「超分」不要动（开发者侧语义保留）。

---

## 十三、宫格分镜提示词调优（行业专业角色 + 死规则接线，旅游版 v1.2.x）

### 动机

宫格分镜图是 H3 视频生成的**唯一视觉真相**，图质（质感）与上下文连贯性直接决定视频上限。审查发现：服务器 `grid_prompt_rules_travel.json` 里已备好一整套质量/连贯规则，但前端 `buildGridPrompt` **只消费了** `reference_image_priority` + 分镜字段 + `frame_quality_suffix`，其余（`global_header` 空间递进/地标锚定、`cinematic_quality` 光影+质感、`continuity_and_axis` 空间连续、`closeup_axis_lock` 特写空间锚、`hard_constraints` 铁律、`grid_layout`）**全是死代码**。同时缺「行业专业角色」提示（persona），模型没有构图/光影的行业语境。本次**只调优提示词**，不碰分辨率与多拼逻辑（按用户要求）。

### 改动文件（2 个：1 前端 + 1 数据）

**1. `src/features/canvas/application/gridPromptRules.ts`**（核心）

- `interface GridPromptRules` 精简为旅游 schema：删掉旧英文 pet 版死字段（`section_identity_lock`/`identity_lock`/`section_scene_lock`/`scene_lock`/`section_camera`/`camera_style`/`section_sequence`/`sequence_context`/`section_visual_carryover`/`visual_identity_carryover`/`section_reference_priority`/`section_prop_spatial_lock`/`prop_spatial_lock`/`section_layout`/`layout_strictness`/`section_hard_constraints`/`action_continuity_fallback`/`facing_inference_rule`/`style_consistent_text`）。保留：`persona?`/`cinematic_quality?`/`closeup_axis_lock?`/`frame_quality_suffix?` 四个可选 + `disable_text_in_image_text?` 可选，其余必填。
- `DEFAULT_RULES` 从旧英文 pet 版整体重写为旅游中文版（照抄 `grid_prompt_rules_travel.json` + persona + disable_text），`version: '1-travel'`。
- `buildGridPrompt` 接线顺序：`persona` → `global_header`(规则A/B) → 布局铁律(硬编码防转置) → `grid_layout`(规则G) → `reference_image_priority`(规则E，仅有参考图时) → `cinematic_quality`(规则C/D) → `continuity_and_axis`(规则F) → `closeup_axis_lock`(特写空间锚) → `disable_text`(仅开关开启且有字段时) → `section_frames`("--- 画面描述 ---") → 分镜字段 → `hard_constraints` → 最终布局确认(硬编码) → `frame_quality_suffix`。
- `buildFrameFields` 新增 `lighting`/`space` 两字段：`detectLighting`（黄金时刻/蓝调时刻/黄昏/夜景/正午/清晨/白天/暖光/冷光/月光/阴天雾）+ `detectSpace`（外观建筑/大门入口/大堂前台/走廊通道/客房/餐厅/健身房泳池/室内/室外/海边/自然地貌/街景古镇）。命中用 `frame_field_source_user`(用户)，未命中给默认值「光影与画面1一致」「空间关系继承前格」标 `(自动)`。
- `disable_text` 分支加守卫 `if (context.disableTextInImage && gp.disable_text_in_image_text)`——旧代码无守卫时，JSON 缺字段会 `push(undefined)` 把字面量 `undefined` 塞进提示词。

**2. `public/grid_prompt_rules_travel.json`**（数据源）

- 新增 `persona`：`"你是一位专业的旅行/酒店/建筑摄影师，擅长电影级光影与空间叙事。"`
- 新增 `disable_text_in_image_text`：`"禁止在图片中新增任何描述文本、字幕、水印、编号或随机字母。仅保留参考图中原有的文字/Logo/标识/牌匾。"`

**3. 上传服务器**（scp，key `$HOME/jiaoyan.pem`）：

```bash
# 先备份旧文件
scp -i "$HOME/jiaoyan.pem" root@47.108.237.10:/jy/uploads/app/grid_prompt_rules_travel.json /tmp/grid_prompt_rules_travel.bak.$(date +%Y%m%d_%H%M%S).json
# 上传
scp -i "$HOME/jiaoyan.pem" public/grid_prompt_rules_travel.json root@47.108.237.10:/jy/uploads/app/grid_prompt_rules_travel.json
# 服务器端校验 JSON
ssh -i "$HOME/jiaoyan.pem" root@47.108.237.10 "python3 -m json.tool /jy/uploads/app/grid_prompt_rules_travel.json > /dev/null && echo OK"
```

### 复刻到其他版本

1. `gridPromptRules.ts` 整文件覆盖（代码通用），但 `DEFAULT_RULES` 已是旅游中文版——覆盖后要把 `DEFAULT_RULES` 整体换成目标行业的规则 JSON 内容 + 目标行业 persona。
2. 目标版本 `grid_prompt_rules_xxx.json` 加 `persona`（换成对应行业角色，如服饰=服装摄影师、科普=科学摄影/显微摄影）+ `disable_text_in_image_text`。
3. scp 上传目标版本 JSON 到 `/jy/uploads/app/`（文件名 `grid_prompt_rules_xxx.json` 与 `update.rs` 的 `GRID_PROMPT_RULES_URL` 一致）。

### 关键坑

1. **persona 是「数据分版本」不是「代码分版本」**：代码读通用字段 `gp.persona`，每个行业版本的 JSON 写自己的行业角色。所以「其他版本是否需要单独文件」——**要，每个版本各有一份 JSON 里的 persona，但代码不用改**。
2. **`disable_text` 守卫必须加**：travel JSON 原本就没有 `disable_text_in_image_text`，不加守卫会 push `undefined` 污染提示词。
3. **布局铁律 + 最终布局确认仍是硬编码**（防转置 `{cols}列×{rows}行` 锁），不从 JSON 读——这是通用强约束，留在代码内。
4. **分辨率/多拼逻辑没动**：`baidu`/`kie` provider 的 `quality`/`composite_reference_images`（多图拼一张）保持原样，本次只调提示词。
5. **上传前先备份 + 警惕 SSH 警告混入文件**：scp 的 `** WARNING: connection is not using a post-quantum key exchange...` 会打到 stderr；之前用重定向下载时警告行混进了本地 JSON 文件头，导致 `JSON.parse` 失败。上传用正常 scp（警告走 stderr 不影响目标文件），下载到本地做对比时 `2>/dev/null` 或事后删头。
