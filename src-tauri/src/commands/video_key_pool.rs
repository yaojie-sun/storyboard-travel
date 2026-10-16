//! 视频生成 KEY 池 / 槽位账本 / 凭证式排队。
//!
//! 背景：H3 视频线路是**租赁带宽模式 —— 1 个 KEY 只支持 3 路并发**。服务端
//! `GET /jy/api/v1/api-configs/active` 本来就返回列表（`ApiResponse<Vec<ApiConfig>>`），
//! 只是客户端过去逐行覆盖、只剩 1 个 KEY。本模块把多行攒成 KEY 池，按 KEY 记并发，
//! 加 KEY 只需在管理后台加数据 —— **不需要发版**。
//!
//! ## 为什么排队是「凭证式」而不是在命令里长 await
//!
//! 朴素做法（在 `banana_submit_video_job` 里 await 到槽位空出来、再扣费提交）会让
//! **用户付钱却拿不到片**。三个事实合起来构成这个洞：
//!   1. 关掉某一格小窗是契约允许的操作（作业仍在跑）—— `VideoGenDialog.tsx::handleDockClose`；
//!   2. `pendingTaskId` 只在提交返回**之后**才落盘 ⇒ 排队阶段什么都没记；
//!   3. 关主窗口时另一个线程 3 秒后 `std::process::exit(0)`（`lib.rs`）⇒ **`Drop` 不执行**。
//! ⇒ 槽位一空，那个没人等的任务照样**扣费 → 提交 → 生成**，taskId 却交给了不存在的调用方。
//!
//! 所以本模块采用凭证式排队：**扣费只发生在前端正在等的那个调用里**。
//! 没有槽位时提交命令立刻返回 `queued:true`，前端每 3 秒问一次 [`status`]，
//! 拿到 `Ready` 才**重发同一次提交**（那一次才占槽 + 扣费 + 提交）。
//! 排队条目靠状态轮询续租（[`QUEUE_LEASE_TTL`]）：前端一停（关窗 / 崩溃 / exit(0)）
//! 租约过期 ⇒ **什么都没扣、什么都没占**。这是结构不变式，不是尽力而为的清理。
//!
//! ## 三条必须守住的规则
//!
//! * **绝不跨 `.await` 持锁**：所有池操作都是纯 CPU（微秒级），
//!   用 `std::sync::Mutex` 而非 tokio 的 —— 因为它能在 `Drop` 里锁（[`SlotGuard`] 需要），
//!   且可以用 `into_inner()` 从中毒中恢复（持锁者 panic 不该让视频生成永久瘫痪）。
//! * **释放一律用 `remove()`，绝不用会自减的计数器** —— 自减计数器是超发与 429 的来源；
//!   `remove()` 天然幂等，重复释放不会把额度算多。
//! * **回收器不是可选项**：`process::exit(0)` 不跑 `Drop`，靠 [`INFLIGHT_TTL`] 兜底。
//!   回收是**惰性**的（在 `try_acquire` / `status` / `heartbeat` 顶部用注入的 `now` 跑），
//!   不开后台定时器，也让分配器可以被单测（零 sleep）。

use std::collections::{HashMap, VecDeque};
use std::sync::{LazyLock, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tracing::{info, warn};

/// 每个 KEY 的默认并发上限（租赁带宽：1 KEY = 3 路）。
pub const DEFAULT_PER_KEY_CONCURRENCY: usize = 3;
/// 每 KEY 并发上限的硬夹取范围，防止服务端配置行填错导致超发。
pub const MAX_PER_KEY_CONCURRENCY: usize = 32;
/// KEY 池条数上限。
pub const MAX_KEYS: usize = 64;
/// 单个 KEY 的长度上限。
pub const MAX_KEY_LEN: usize = 512;
/// 排队长度上限，超过直接拒绝（未扣费）。
pub const DEFAULT_MAX_WAITING: usize = 30;
/// 排队租约：前端每 3 秒轮询续租，4 拍不续即视为放弃。
pub const QUEUE_LEASE_TTL: Duration = Duration::from_secs(12);
/// 在飞槽位租约：自**最后一次心跳**起算（前端每 3 秒一次心跳）。
/// 取得比 `MAX_POLL_MS`（100 分钟）保守但远大于正常生成时长 ——
/// 回收一个其实还在跑的槽位只会导致一次「发到忙 KEY 上」的 429（可退费），不会重复扣费。
pub const INFLIGHT_TTL: Duration = Duration::from_secs(30 * 60);
/// 上游 429 后该 KEY 的冷却时长。
pub const COOLDOWN_429: Duration = Duration::from_secs(60);
/// 终态凭据保留时长：防止同一个 token 被重发导致重复扣费。
pub const TERMINAL_TTL: Duration = Duration::from_secs(5 * 60);
/// 任务 → KEY 指纹 的落盘文件名（放在 `users/{id}/` 下）。
const JOB_KEYS_FILENAME: &str = "video_job_keys.json";
/// 指纹文件保留时长与条数上限。
const JOB_KEYS_TTL_SECS: u64 = 48 * 60 * 60;
const JOB_KEYS_MAX_ENTRIES: usize = 256;

// ───────────────────────────── 纯解析 ─────────────────────────────

/// KEY 指纹：sha256 前 16 位十六进制。
///
/// 用途：**跨重启定位任务用的是哪个 KEY**，但绝不会把 KEY 本身落盘或打日志。
/// 单向哈希 ⇒ 日志里的指纹不构成泄漏。
pub fn fingerprint(key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(key.as_bytes());
    hex::encode(hasher.finalize())[..16].to_string()
}

/// 把一个配置行的 `api_key` 值解析成 KEY 列表。
///
/// 同时支持两种服务端配置方式（后台用哪种都行）：
/// * 多行同 `api_type` 的配置（每行一个 KEY）—— 由调用方累积后再传进来；
/// * 单行里用 换行 / 逗号 / 分号 分隔的多个 KEY。
///
/// 会丢掉：空串、含 ASCII 空白、含非 ASCII、超过 [`MAX_KEY_LEN`] 的片段；
/// 去重且**保序**；总数不超过 [`MAX_KEYS`]。
pub fn parse_key_list(raw: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for piece in raw.split([',', '\n', '\r', ';']) {
        let mut s = piece.trim();
        // 容忍粘贴时带上 "Bearer " 前缀
        if let Some(rest) = s.strip_prefix("Bearer ").or_else(|| s.strip_prefix("bearer ")) {
            s = rest.trim();
        }
        if s.is_empty() || s.len() > MAX_KEY_LEN {
            continue;
        }
        // KEY 不该含空白，也不该含非 ASCII（粘贴带进了全角字符 / 说明文字）
        if s.chars().any(|c| c.is_whitespace() || !c.is_ascii()) {
            continue;
        }
        if out.iter().any(|k| k == s) {
            continue;
        }
        out.push(s.to_string());
        if out.len() >= MAX_KEYS {
            break;
        }
    }
    out
}

/// 解析「每 KEY 并发数」配置行的值。非法 / 缺失返回 `None`（调用方用默认值）。
pub fn parse_concurrency(raw: &str) -> Option<usize> {
    let v: usize = raw.trim().parse().ok()?;
    if v == 0 {
        return None;
    }
    Some(v.min(MAX_PER_KEY_CONCURRENCY))
}

// ───────────────────────────── 状态 ─────────────────────────────

#[derive(Clone)]
struct KeySlot {
    key: String,
    fp: String,
}

struct Inflight {
    key: String,
    fp: String,
    task_id: Option<String>,
    /// 最后一次心跳（轮询到了 Queued / Running 就刷一次）。
    hb: Instant,
}

struct Waiter {
    token: String,
    /// 最后一次续租时间。
    seen: Instant,
}

/// 取槽结果。`acquire` 的语义：只有 `Granted` 才代表**已经占了槽**，调用方随后必须
/// 要么 [`Pool::bind_task`]（成功提交，槽位交给轮询释放），要么让 [`SlotGuard`] 掉下来（失败释放）。
pub enum Acquire {
    Granted {
        key: String,
        index: usize,
        capacity: usize,
        in_flight: usize,
    },
    Waiting {
        ahead: usize,
        capacity: usize,
        in_flight: usize,
    },
    /// 队列已满 —— 立刻拒绝，**未扣费**。
    Full {
        capacity: usize,
        in_flight: usize,
    },
    /// 同一个 token 已经提交过 / 已经失败过：拒绝重发（防重复扣费）。
    Terminal,
    /// 池是空的（服务端没下发 KEY）—— 调用方按「密钥未配置」报错。
    NoKeys,
}

pub enum Status {
    /// 轮到自己了，可以重发提交。
    Ready,
    Waiting { ahead: usize, capacity: usize, in_flight: usize },
    /// 不在队列里：租约过期 / 已被取消 / token 不认。
    Gone,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct Snapshot {
    pub key_count: usize,
    pub per_key: usize,
    pub capacity: usize,
    pub in_flight: usize,
    pub waiting: usize,
}

struct Pool {
    keys: Vec<KeySlot>,
    per_key: usize,
    max_waiting: usize,
    /// 轮转游标：让并发的任务均匀落到不同 KEY 上。
    rr: usize,
    inflight: HashMap<String, Inflight>,
    task_index: HashMap<String, String>,
    waiting: VecDeque<Waiter>,
    /// KEY 指纹 → 冷却截止时刻。
    cooldown: HashMap<String, Instant>,
    /// 已终结的凭据（token → 时刻）。
    terminal: HashMap<String, Instant>,
}

impl Pool {
    fn new() -> Self {
        Self {
            keys: Vec::new(),
            per_key: DEFAULT_PER_KEY_CONCURRENCY,
            max_waiting: DEFAULT_MAX_WAITING,
            rr: 0,
            inflight: HashMap::new(),
            task_index: HashMap::new(),
            waiting: VecDeque::new(),
            cooldown: HashMap::new(),
            terminal: HashMap::new(),
        }
    }

    fn capacity(&self) -> usize {
        self.keys.len() * self.per_key
    }

    fn is_cooling(&self, fp: &str, now: Instant) -> bool {
        self.cooldown.get(fp).is_some_and(|until| *until > now)
    }

    fn load(&self, fp: &str) -> usize {
        self.inflight.values().filter(|f| f.fp == fp).count()
    }

    /// 惰性回收：过期排队条目 / 过期在飞槽位 / 过期冷却 / 过期终态凭据。
    fn reap(&mut self, now: Instant) {
        self.waiting
            .retain(|w| now.duration_since(w.seen) <= QUEUE_LEASE_TTL);

        let stale: Vec<String> = self
            .inflight
            .iter()
            .filter(|(_, f)| now.duration_since(f.hb) > INFLIGHT_TTL)
            .map(|(t, _)| t.clone())
            .collect();
        for token in stale {
            if let Some(f) = self.inflight.remove(&token) {
                if let Some(tid) = f.task_id {
                    self.task_index.remove(&tid);
                }
                warn!(
                    "[VideoPool] 在飞槽位超时回收（前端可能已停止轮询）token={}",
                    token
                );
            }
        }

        self.cooldown.retain(|_, until| *until > now);
        self.terminal
            .retain(|_, at| now.duration_since(*at) <= TERMINAL_TTL);
    }

    /// 当前可用槽位数。
    ///
    /// 冷却中的 KEY 不计入；**若全部 KEY 都在冷却**，则放行最早到期的那个，
    /// 否则一次 429 会把整个视频线路锁死 60 秒。
    fn free_slots(&self, now: Instant) -> usize {
        let normal: usize = self
            .keys
            .iter()
            .filter(|k| !self.is_cooling(&k.fp, now))
            .map(|k| self.per_key.saturating_sub(self.load(&k.fp)))
            .sum();
        if normal > 0 {
            return normal;
        }
        self.keys
            .iter()
            .map(|k| self.per_key.saturating_sub(self.load(&k.fp)))
            .sum()
    }

    /// 选一个可用 KEY（轮转 + 跳过冷却），不改状态。
    fn select(&self, now: Instant) -> Option<usize> {
        if self.keys.is_empty() {
            return None;
        }
        let n = self.keys.len();
        for step in 0..n {
            let idx = (self.rr + step) % n;
            let k = &self.keys[idx];
            if self.is_cooling(&k.fp, now) {
                continue;
            }
            if self.load(&k.fp) < self.per_key {
                return Some(idx);
            }
        }
        // 全在冷却 / 全满：只在「全部冷却」时放行最早到期的那个
        if self.keys.iter().all(|k| self.is_cooling(&k.fp, now)) {
            let mut best: Option<(usize, Instant)> = None;
            for (idx, k) in self.keys.iter().enumerate() {
                if self.load(&k.fp) >= self.per_key {
                    continue;
                }
                let until = self.cooldown.get(&k.fp).copied().unwrap_or(now);
                if best.is_none_or(|(_, b)| until < b) {
                    best = Some((idx, until));
                }
            }
            return best.map(|(idx, _)| idx);
        }
        None
    }

    fn position_of(&self, token: &str) -> Option<usize> {
        self.waiting.iter().position(|w| w.token == token)
    }

    fn try_acquire(&mut self, token: &str, now: Instant) -> Acquire {
        self.reap(now);

        if self.inflight.contains_key(token) || self.terminal.contains_key(token) {
            return Acquire::Terminal;
        }
        if self.keys.is_empty() {
            return Acquire::NoKeys;
        }

        // ⚠️ 位置必须在出队**之前**取：拿到 `Ready` 的队首回来重发时，
        //    它本来就该排在最前面；先 retain 再算位置会把它当成新来者丢到队尾。
        let existed = self.position_of(token).is_some();
        let pos = self.position_of(token).unwrap_or(self.waiting.len());
        // 自己先出队（重发场景避免自己挡住自己）
        self.waiting.retain(|w| w.token != token);

        // FIFO 的取槽规则：**在我前面等的人数 < 当前空位数**才轮到我。
        // 保序性来自这里 —— 绝不会出现「我拿到了、排在我前面且有空位的人反而没拿到」。
        // 新来者的有效位置 = 队尾，因此「池空且无人在等」时它会立刻拿到槽位（0 < free）。
        let free = self.free_slots(now);
        if pos < free {
            if let Some(idx) = self.select(now) {
                self.rr = (idx + 1) % self.keys.len();
                let slot = self.keys[idx].clone();
                self.inflight.insert(
                    token.to_string(),
                    Inflight {
                        key: slot.key.clone(),
                        fp: slot.fp,
                        task_id: None,
                        hb: now,
                    },
                );
                return Acquire::Granted {
                    key: slot.key,
                    index: idx,
                    capacity: self.capacity(),
                    in_flight: self.inflight.len(),
                };
            }
            // free>0 却说没有可用 KEY（竞态兜底）：退化成排队
        }

        if !existed && self.waiting.len() >= self.max_waiting {
            return Acquire::Full {
                capacity: self.capacity(),
                in_flight: self.inflight.len(),
            };
        }
        self.enqueue(token, now);
        self.waiting_result(token)
    }

    fn enqueue(&mut self, token: &str, now: Instant) {
        match self.waiting.iter_mut().find(|w| w.token == token) {
            // 已在队列里：只续租，位置不动
            Some(w) => w.seen = now,
            None => self.waiting.push_back(Waiter {
                token: token.to_string(),
                seen: now,
            }),
        }
    }

    fn waiting_result(&mut self, token: &str) -> Acquire {
        // 上面刚 enqueue，正常必命中；兜底给 0 而不是 usize::MAX，避免把怪值透传到前端
        let ahead = self.position_of(token).unwrap_or(0);
        Acquire::Waiting {
            ahead,
            capacity: self.capacity(),
            in_flight: self.inflight.len(),
        }
    }

    fn status(&mut self, token: &str, now: Instant) -> Status {
        self.reap(now);
        if self.inflight.contains_key(token) || self.terminal.contains_key(token) {
            // 已经拿到槽位（前端本该在等提交结果，不该再问状态）
            return Status::Gone;
        }
        match self.position_of(token) {
            None => Status::Gone,
            Some(pos) => {
                let free = self.free_slots(now);
                if pos < free {
                    Status::Ready
                } else {
                    Status::Waiting {
                        ahead: pos,
                        capacity: self.capacity(),
                        in_flight: self.inflight.len(),
                    }
                }
            }
        }
    }

    fn cancel(&mut self, token: &str, now: Instant) -> bool {
        self.reap(now);
        let before = self.waiting.len();
        self.waiting.retain(|w| w.token != token);
        let removed = self.waiting.len() != before;
        if removed {
            self.terminal.insert(token.to_string(), now);
        }
        removed
    }

    fn bind_task(&mut self, token: &str, task_id: &str, now: Instant) {
        if let Some(f) = self.inflight.get_mut(token) {
            f.task_id = Some(task_id.to_string());
            f.hb = now;
            self.task_index.insert(task_id.to_string(), token.to_string());
        }
    }

    /// 断点续接用：把「任务 → KEY」补回内存（重启后由指纹文件恢复）。
    fn remember_task_key(&mut self, task_id: &str, key: &str, now: Instant) {
        let fp = fingerprint(key);
        let token = format!("recovered:{task_id}");
        self.inflight.insert(
            token.clone(),
            Inflight {
                key: key.to_string(),
                fp,
                task_id: Some(task_id.to_string()),
                hb: now,
            },
        );
        self.task_index.insert(task_id.to_string(), token);
    }

    fn resolve_key_for_task(&self, task_id: &str) -> Option<String> {
        let token = self.task_index.get(task_id)?;
        self.inflight.get(token).map(|f| f.key.clone())
    }

    fn release_token(&mut self, token: &str, now: Instant) -> bool {
        let existed = self.inflight.remove(token).is_some();
        // 顺带清掉该 token 的排队位
        self.waiting.retain(|w| w.token != token);
        if existed {
            self.terminal.insert(token.to_string(), now);
        }
        existed
    }

    fn release_task(&mut self, task_id: &str, now: Instant) -> bool {
        let token = match self.task_index.remove(task_id) {
            Some(t) => t,
            None => return false,
        };
        let existed = self.inflight.remove(&token).is_some();
        self.terminal.insert(token, now);
        existed
    }

    fn heartbeat(&mut self, task_id: &str, now: Instant) {
        if let Some(token) = self.task_index.get(task_id).cloned() {
            if let Some(f) = self.inflight.get_mut(&token) {
                f.hb = now;
            }
        }
    }

    fn heartbeat_token(&mut self, token: &str, now: Instant) {
        if let Some(w) = self.waiting.iter_mut().find(|w| w.token == token) {
            w.seen = now;
        }
    }

    fn mark_429_by_key(&mut self, key: &str, now: Instant) {
        self.cooldown.insert(fingerprint(key), now + COOLDOWN_429);
    }

    fn replace(&mut self, keys: Vec<String>, per_key: Option<usize>) {
        if keys.is_empty() {
            // 关键：服务端偶发返回空 / 部分响应时，绝不能把还能用的 KEY 抹掉
            if !self.keys.is_empty() {
                warn!(
                    "[VideoPool] 本次同步下发 0 个 KEY，保留原有 {} 个",
                    self.keys.len()
                );
            }
            return;
        }
        let old_len = self.keys.len();
        self.keys = keys
            .into_iter()
            .map(|key| KeySlot {
                fp: fingerprint(&key),
                key,
            })
            .collect();
        self.per_key = per_key.unwrap_or(DEFAULT_PER_KEY_CONCURRENCY);
        self.rr = 0;
        // 在飞记录自带 KEY 字符串，故轮换 KEY 不会打断正在跑的任务；
        // 但冷却槽位按指纹记，被移除的 KEY 的冷却记录留着无害（会自己过期）。
        info!(
            "[VideoPool] KEY 池更新: {} → {} 个, 每 KEY 并发 {}, 容量 {}",
            old_len,
            self.keys.len(),
            self.per_key,
            self.capacity()
        );
    }

    fn reset(&mut self) {
        self.keys.clear();
        self.inflight.clear();
        self.task_index.clear();
        self.waiting.clear();
        self.cooldown.clear();
        self.terminal.clear();
        self.rr = 0;
    }

    fn snapshot(&mut self, now: Instant) -> Snapshot {
        self.reap(now);
        Snapshot {
            key_count: self.keys.len(),
            per_key: self.per_key,
            capacity: self.capacity(),
            in_flight: self.inflight.len(),
            waiting: self.waiting.len(),
        }
    }
}

// ───────────────────────────── 全局单例 ─────────────────────────────

static POOL: LazyLock<Mutex<Pool>> = LazyLock::new(|| Mutex::new(Pool::new()));

/// 中毒恢复：持锁者 panic 不该让视频生成永久瘫痪。
fn lock() -> MutexGuard<'static, Pool> {
    POOL.lock().unwrap_or_else(|e| e.into_inner())
}

/// 更新 KEY 池。空输入不动（见 [`Pool::replace`]，调用方已保证收集后再一次性调用）。
pub fn replace_keys(keys: Vec<String>, per_key: Option<usize>) {
    lock().replace(keys, per_key);
}

/// 兼容取用：拿池里的第一个 KEY（老调用点 / 兜底）。
pub fn first_key() -> Option<String> {
    lock().keys.first().map(|k| k.key.clone())
}

/// 登出 / 切换用户：整池清空，避免跨账号用错 KEY 轮询。
pub fn reset() {
    lock().reset();
}

pub fn try_acquire(token: &str, now: Instant) -> Acquire {
    lock().try_acquire(token, now)
}

pub fn status(token: &str, now: Instant) -> Status {
    lock().status(token, now)
}

pub fn cancel(token: &str, now: Instant) -> bool {
    lock().cancel(token, now)
}

pub fn bind_task(token: &str, task_id: &str, now: Instant) {
    lock().bind_task(token, task_id, now)
}

pub fn remember_task_key(task_id: &str, key: &str, now: Instant) {
    lock().remember_task_key(task_id, key, now);
}

pub fn resolve_key_for_task(task_id: &str) -> Option<String> {
    lock().resolve_key_for_task(task_id)
}

pub fn release_task(task_id: &str, now: Instant) -> bool {
    lock().release_task(task_id, now)
}

pub fn release_token(token: &str, now: Instant) -> bool {
    lock().release_token(token, now)
}

pub fn heartbeat(task_id: &str, now: Instant) {
    lock().heartbeat(task_id, now);
}

pub fn heartbeat_token(token: &str, now: Instant) {
    lock().heartbeat_token(token, now);
}

pub fn mark_429_by_key(key: &str, now: Instant) {
    lock().mark_429_by_key(key, now);
}

/// 已有指纹时的冷却入口（提交路径手里只有指纹）。
pub fn mark_429_by_fp(fp: &str, now: Instant) {
    lock().cooldown.insert(fp.to_string(), now + COOLDOWN_429);
}

pub fn snapshot() -> Snapshot {
    lock().snapshot(Instant::now())
}

/// 槽位守卫：覆盖提交路径上所有失败 / 提前返回。
///
/// ⚠️ `Drop` **不会**在 `std::process::exit(0)` 时执行（`lib.rs` 的关闭兜底），
/// 所以它只是「正常路径下更快释放」，真正兜底的是 [`INFLIGHT_TTL`] 惰性回收。
pub struct SlotGuard {
    token: Option<String>,
}

impl SlotGuard {
    pub fn new(token: impl Into<String>) -> Self {
        Self {
            token: Some(token.into()),
        }
    }

    /// 已成功提交、槽位交给轮询释放时调用。
    pub fn disarm(&mut self) {
        self.token = None;
    }
}

impl Drop for SlotGuard {
    fn drop(&mut self) {
        if let Some(token) = self.token.take() {
            release_token(&token, Instant::now());
        }
    }
}

// ───────────────────────────── 任务 → KEY 指纹落盘 ─────────────────────────────

#[derive(Serialize, Deserialize)]
struct JobKeyFile {
    v: u32,
    tasks: HashMap<String, JobKeyEntry>,
}

#[derive(Serialize, Deserialize)]
struct JobKeyEntry {
    fp: String,
    at: u64,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn job_keys_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    crate::sync::get_user_dir(app).map(|dir| dir.join(JOB_KEYS_FILENAME))
}

/// 记下「任务 → KEY 指纹」。
///
/// 只在内存里存 KEY，落盘的只有指纹（单向哈希）。跨重启恢复「轮询该用哪个 KEY」
/// 必须靠它 —— 否则重启后拿别的 KEY 去查，可能被当成任务失败而**误退费**。
pub async fn record_task_key(app: &AppHandle, task_id: &str, fp: &str) {
    let path = match job_keys_path(app) {
        Ok(p) => p,
        Err(e) => {
            warn!("[VideoPool] 指纹落盘跳过（{}）", e);
            return;
        }
    };

    let mut file = match tokio::fs::read_to_string(&path).await {
        Ok(text) => serde_json::from_str::<JobKeyFile>(&text).unwrap_or(JobKeyFile {
            v: 1,
            tasks: HashMap::new(),
        }),
        Err(_) => JobKeyFile {
            v: 1,
            tasks: HashMap::new(),
        },
    };

    let cutoff = now_secs().saturating_sub(JOB_KEYS_TTL_SECS);
    file.tasks.retain(|_, e| e.at >= cutoff);
    if file.tasks.len() >= JOB_KEYS_MAX_ENTRIES {
        // 超上限：丢掉最老的一半，避免文件无界增长
        let mut entries: Vec<(String, u64)> =
            file.tasks.iter().map(|(k, v)| (k.clone(), v.at)).collect();
        entries.sort_by_key(|(_, at)| *at);
        for (k, _) in entries.into_iter().take(file.tasks.len() / 2) {
            file.tasks.remove(&k);
        }
    }
    file.tasks.insert(
        task_id.to_string(),
        JobKeyEntry {
            fp: fp.to_string(),
            at: now_secs(),
        },
    );

    let json = match serde_json::to_string(&file) {
        Ok(j) => j,
        Err(e) => {
            warn!("[VideoPool] 指纹序列化失败: {}", e);
            return;
        }
    };
    let tmp = path.with_extension("json.tmp");
    if tokio::fs::write(&tmp, json).await.is_err() {
        warn!("[VideoPool] 指纹写入临时文件失败");
        return;
    }
    if let Err(e) = tokio::fs::rename(&tmp, &path).await {
        warn!("[VideoPool] 指纹落盘失败: {}", e);
    }
}

/// 读出某个任务的 KEY 指纹（跨重启恢复用）。
pub async fn load_task_fp(app: &AppHandle, task_id: &str) -> Option<String> {
    let path = job_keys_path(app).ok()?;
    let text = tokio::fs::read_to_string(&path).await.ok()?;
    let file: JobKeyFile = serde_json::from_str(&text).ok()?;
    file.tasks.get(task_id).map(|e| e.fp.clone())
}

/// 按指纹从池里找回 KEY（池顺序变了也能对上），并记回内存。
pub fn key_by_fingerprint(fp: &str, task_id: &str, now: Instant) -> Option<String> {
    let mut pool = lock();
    let key = pool.keys.iter().find(|k| k.fp == fp).map(|k| k.key.clone())?;
    pool.remember_task_key(task_id, &key, now);
    Some(key)
}

/// 清掉某个任务的指纹记录（终态后调用，避免文件长大）。
pub async fn forget_task_key(app: &AppHandle, task_id: &str) {
    let path = match job_keys_path(app) {
        Ok(p) => p,
        Err(_) => return,
    };
    let text = match tokio::fs::read_to_string(&path).await {
        Ok(t) => t,
        Err(_) => return,
    };
    let mut file: JobKeyFile = match serde_json::from_str(&text) {
        Ok(f) => f,
        Err(_) => return,
    };
    if file.tasks.remove(task_id).is_none() {
        return;
    }
    if let Ok(json) = serde_json::to_string(&file) {
        let tmp = path.with_extension("json.tmp");
        if tokio::fs::write(&tmp, json).await.is_ok() {
            let _ = tokio::fs::rename(&tmp, &path).await;
        }
    }
}

// ───────────────────────────── 单测 ─────────────────────────────
//
// 只用本地 `Pool` 实例（不碰全局单例），因此测试之间互不干扰、可并行。
// `now` 全部注入 ⇒ 零 sleep、零 flaky。

#[cfg(test)]
mod tests {
    use super::*;

    fn t0() -> Instant {
        Instant::now()
    }

    fn pool3() -> Pool {
        let mut p = Pool::new();
        p.replace(
            vec!["sk-a".to_string(), "sk-b".to_string(), "sk-c".to_string()],
            Some(3),
        );
        p
    }

    #[test]
    fn parse_key_list_splits_and_cleans() {
        assert_eq!(parse_key_list("sk-1"), vec!["sk-1"]);
        assert_eq!(
            parse_key_list("sk-1, sk-2;sk-3\nsk-4\r\nsk-5"),
            vec!["sk-1", "sk-2", "sk-3", "sk-4", "sk-5"]
        );
        // 去重且保序
        assert_eq!(parse_key_list("b,a,b"), vec!["b", "a"]);
        // Bearer 前缀 + 空白
        assert_eq!(parse_key_list("  Bearer sk-x  "), vec!["sk-x"]);
        // 空 / 含空白 / 非 ASCII 全丢
        assert!(parse_key_list("").is_empty());
        assert!(parse_key_list("  ,  ;  ").is_empty());
        assert!(parse_key_list("sk-1 sk-2").is_empty(), "含空格视为非法");
        assert!(parse_key_list("sk-全角").is_empty(), "非 ASCII 视为非法");
        // 超长丢弃
        let long = "x".repeat(MAX_KEY_LEN + 1);
        assert!(parse_key_list(&long).is_empty());
    }

    #[test]
    fn parse_key_list_caps_at_max_keys() {
        let raw = (0..200)
            .map(|i| format!("sk-{i}"))
            .collect::<Vec<_>>()
            .join(",");
        assert_eq!(parse_key_list(&raw).len(), MAX_KEYS);
    }

    #[test]
    fn parse_concurrency_is_strict_and_clamped() {
        assert_eq!(parse_concurrency("3"), Some(3));
        assert_eq!(parse_concurrency(" 9 "), Some(9));
        assert_eq!(parse_concurrency("0"), None);
        assert_eq!(parse_concurrency("abc"), None);
        assert_eq!(parse_concurrency(""), None);
        assert_eq!(parse_concurrency("999"), Some(MAX_PER_KEY_CONCURRENCY));
    }

    #[test]
    fn fingerprint_is_stable_and_distinct() {
        assert_eq!(fingerprint("sk-a"), fingerprint("sk-a"));
        assert_ne!(fingerprint("sk-a"), fingerprint("sk-b"));
        assert_eq!(fingerprint("sk-a").len(), 16);
    }

    #[test]
    fn capacity_and_round_robin_distribution() {
        let now = t0();
        let mut p = pool3();
        assert_eq!(p.capacity(), 9);

        let mut granted: Vec<usize> = Vec::new();
        for i in 0..9 {
            match p.try_acquire(&format!("t{i}"), now) {
                Acquire::Granted { index, .. } => granted.push(index),
                _ => panic!("第 {i} 个应该拿到槽位"),
            }
        }
        // 3/3/3 均匀分布
        for idx in 0..3 {
            assert_eq!(granted.iter().filter(|g| **g == idx).count(), 3);
        }
        // 第 10 个排队（队首，前面 0 个）
        match p.try_acquire("t9", now) {
            Acquire::Waiting { ahead, .. } => assert_eq!(ahead, 0),
            _ => panic!("第 10 个应该排队"),
        }
    }

    #[test]
    fn fifo_order_and_ready_window() {
        let now = t0();
        let mut p = pool3();
        for i in 0..9 {
            assert!(matches!(
                p.try_acquire(&format!("t{i}"), now),
                Acquire::Granted { .. }
            ));
        }
        for i in 0..3 {
            match p.try_acquire(&format!("q{i}"), now) {
                Acquire::Waiting { ahead, .. } => assert_eq!(ahead, i),
                _ => panic!("q{i} 应该排队在第 {i} 位"),
            }
        }
        // 释放一个 → 队首可以走，后面还不行（这就是「位置 < 空位数」的闸）
        assert!(p.release_token("t0", now));
        assert!(matches!(p.status("q0", now), Status::Ready));
        assert!(matches!(p.status("q1", now), Status::Waiting { .. }));
        // 队首重发 → 拿到槽位（位置不能因为「先出队再算位置」而丢）
        assert!(matches!(
            p.try_acquire("q0", now),
            Acquire::Granted { .. }
        ));
        // 再释放一个：队首 q1 可走，q2 还不行（空位只有 1 个）
        assert!(p.release_token("t1", now));
        assert!(matches!(p.status("q1", now), Status::Ready));
        assert!(matches!(p.status("q2", now), Status::Waiting { .. }));
        // 新来者不得插队：前面还有 2 个人在等，只有 1 个空位
        match p.try_acquire("newcomer", now) {
            Acquire::Waiting { ahead, .. } => assert_eq!(ahead, 2, "新来者应排在 q1/q2 之后"),
            other => panic!(
                "新来者不该拿到槽位: {}",
                matches!(other, Acquire::Granted { .. })
            ),
        }
    }

    #[test]
    fn release_is_idempotent_never_negative() {
        let now = t0();
        let mut p = pool3();
        assert!(matches!(p.try_acquire("t0", now), Acquire::Granted { .. }));
        assert!(p.release_token("t0", now));
        assert!(!p.release_token("t0", now), "重复释放应为 false");
        assert_eq!(p.inflight.len(), 0);
        assert_eq!(p.snapshot(now).in_flight, 0);
    }

    #[test]
    fn terminal_token_cannot_be_reacquired() {
        let now = t0();
        let mut p = pool3();
        assert!(matches!(p.try_acquire("t0", now), Acquire::Granted { .. }));
        p.bind_task("t0", "tsk-1", now);
        // 槽位仍在 → 同一个 token 再抢 = 已终结
        assert!(matches!(p.try_acquire("t0", now), Acquire::Terminal));
        assert!(p.release_task("tsk-1", now));
        // 释放后仍是终结态（防重复扣费的回归闸）
        assert!(matches!(p.try_acquire("t0", now), Acquire::Terminal));
        // 过期后可以复用（终态凭据有 TTL）
        let later = now + TERMINAL_TTL + Duration::from_secs(1);
        assert!(matches!(p.try_acquire("t0", later), Acquire::Granted { .. }));
    }

    #[test]
    fn reap_drops_expired_waiters() {
        let now = t0();
        let mut p = pool3();
        for i in 0..9 {
            p.try_acquire(&format!("t{i}"), now);
        }
        assert!(matches!(
            p.try_acquire("q0", now),
            Acquire::Waiting { ahead: 0, .. }
        ));
        assert_eq!(p.snapshot(now).waiting, 1);
        let after_lease = now + QUEUE_LEASE_TTL + Duration::from_secs(1);
        assert_eq!(p.snapshot(after_lease).waiting, 0, "不续租就该掉队");
        assert!(matches!(p.status("q0", after_lease), Status::Gone));
    }

    #[test]
    fn reap_reclaims_stale_inflight_but_respects_heartbeat() {
        let now = t0();
        let mut p = pool3();
        p.try_acquire("t0", now);
        p.bind_task("t0", "tsk-1", now);

        // 持续心跳：90 分钟后仍不该被回收
        let t90 = now + Duration::from_secs(90 * 60);
        for k in 1..=(90 * 60 / 60) {
            p.heartbeat("tsk-1", now + Duration::from_secs(k * 60));
        }
        assert_eq!(p.snapshot(t90).in_flight, 1, "有心跳不该回收");

        // 停止心跳：超过 INFLIGHT_TTL 后回收
        let after = t90 + INFLIGHT_TTL + Duration::from_secs(1);
        assert_eq!(p.snapshot(after).in_flight, 0, "无心跳应回收");
        assert!(p.resolve_key_for_task("tsk-1").is_none());
    }

    #[test]
    fn task_key_binding_survives_and_resolves() {
        let now = t0();
        let mut p = pool3();
        let key = match p.try_acquire("t0", now) {
            Acquire::Granted { key, .. } => key,
            _ => panic!("应拿到槽位"),
        };
        p.bind_task("t0", "tsk-9", now);
        assert_eq!(p.resolve_key_for_task("tsk-9").as_deref(), Some(key.as_str()));
        // 轮询期间释放 → 解绑
        assert!(p.release_task("tsk-9", now));
        assert!(p.resolve_key_for_task("tsk-9").is_none());
    }

    #[test]
    fn cooldown_skips_key_and_all_cooling_does_not_lock_out() {
        let now = t0();
        let mut p = pool3();
        p.mark_429_by_key("sk-a", now);
        // sk-a 冷却 → 优先把任务发到 b / c
        for i in 0..6 {
            match p.try_acquire(&format!("t{i}"), now) {
                Acquire::Granted { key, .. } => assert_ne!(key, "sk-a"),
                _ => panic!("前 6 个应全授予（b/c 各 3）"),
            }
        }
        // 全部冷却也不锁死：最早到期的 KEY 仍可发放
        p.mark_429_by_key("sk-b", now);
        p.mark_429_by_key("sk-c", now);
        assert!(
            matches!(p.try_acquire("t6", now), Acquire::Granted { .. }),
            "全部冷却时必须放行，否则整条线路锁死"
        );
    }

    #[test]
    fn replace_keys_ignores_empty_input() {
        let now = t0();
        let mut p = pool3();
        p.replace(Vec::new(), None);
        assert_eq!(p.keys.len(), 3, "空输入绝不能抹掉还能用的 KEY");
        assert!(matches!(p.try_acquire("t0", now), Acquire::Granted { .. }));
    }

    #[test]
    fn empty_pool_reports_no_keys_and_queue_full_rejects() {
        let now = t0();
        let mut p = Pool::new();
        assert!(matches!(p.try_acquire("t0", now), Acquire::NoKeys));

        let mut q = pool3();
        for i in 0..9 {
            q.try_acquire(&format!("t{i}"), now);
        }
        q.max_waiting = 2;
        q.try_acquire("q0", now);
        q.try_acquire("q1", now);
        assert!(matches!(q.try_acquire("q2", now), Acquire::Full { .. }));
    }

    #[test]
    fn cancel_removes_waiter_and_is_terminal() {
        let now = t0();
        let mut p = pool3();
        for i in 0..9 {
            p.try_acquire(&format!("t{i}"), now);
        }
        p.try_acquire("q0", now);
        assert!(p.cancel("q0", now));
        assert!(!p.cancel("q0", now), "重复取消应为 false");
        assert!(matches!(p.status("q0", now), Status::Gone));
        assert!(matches!(p.try_acquire("q0", now), Acquire::Terminal));
    }

    #[test]
    fn reset_clears_everything() {
        let now = t0();
        let mut p = pool3();
        p.try_acquire("t0", now);
        p.reset();
        assert_eq!(p.snapshot(now).in_flight, 0);
        assert_eq!(p.snapshot(now).key_count, 0);
    }
}
