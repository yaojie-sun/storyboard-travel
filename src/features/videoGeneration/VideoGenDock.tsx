/**
 * 视频生成「缩小」后的右侧停靠侧栏 + 完成提示条。
 *
 * 🔴 **这是同一个 `VideoGenDialogInner` 实例的第二种形态，不是第二个弹窗。**
 * 内层在 docked 形态下**保持挂载**（`key = nodeId`），所以轮询、`videoUrl`、
 * 阶段、已用时长全部原地保留，展开回来与缩小前逐字一致（CLAUDE.md §12.4）。
 *
 * 🔴 **本组件的两个硬约束（后人别破）**
 *
 * 1. **不许加「重新生成 / 重试」按钮。** 驱动 phase 的只有内层那个续接 effect
 *    （`VideoGenDialog.tsx:508`，deps 为 `[]`）—— 它**只在挂载时评估一次**
 *    `savedConfig.pendingTaskId`。侧栏里新起的作业没有任何东西去轮询它，
 *    按下去只会得到一个永远停在「排队中」的死状态。
 *
 * 2. **不许显示百分比。** 后端 `VideoPollResult`（`src/commands/ai.ts:927-933`）
 *    只有 `queued | running | succeeded | failed | retry` 五个状态，
 *    **没有任何进度字段**。这里的不定量条纹条是刻意的：它老实表达「在动、进度未知」，
 *    一个编出来的「62%」比没有更糟。
 *
 * 同理，「已用时长」的口径必须写「**本次已等待**」而不是「已生成 N 分钟」——
 * 它量的是本次轮询开始的时刻（`startPolling` 的 `startTime`），
 * 跨会话续接时会从 0 重算，说成「已生成」就是假的。
 *
 * ── 多个小窗并存 ──
 *
 * 右侧侧栏是从 `D:\Story-Local` 移植过来的：**一个容器 + 每个作业一张卡**（用户可以同时
 * 缩好几个作业，一个在生成、一个在排队）。两处结构性变化，都在本文件：
 *
 * 1. **定位从卡片搬到容器**（`fixed right-4 top-16 flex-col gap-3` 那段在
 *    `VideoGenDialog.tsx` 的外层 host 里）。卡片自己不再有 `fixed` ——
 *    否则多张卡会**完全重叠**在同一个坐标上。
 * 2. **卡片用 `createPortal` 投进那个容器**。为什么不用「把卡片直接嵌进容器的 React 子树」：
 *    那会让元素在 React 树里**换父节点** ⇒ 重新挂载 ⇒ 内层被卸载 ⇒
 *    `VideoGenDialog.tsx:534` 的清理函数 `abort()` 掉轮询，作业的成片就不会下载落盘了。
 *    portal 只挪 DOM 位置，**React 树里位置不变（key 仍是 nodeId）** ⇒ 实例保活。
 */
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, ChevronRight, Film, LoaderCircle, X } from 'lucide-react';
import { useProjectStore } from '@/stores/projectStore';

/** 秒 → `mm:ss`。时长口径见文件头第 2 条。 */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

export interface VideoGenDockProps {
  isGenerating: boolean;
  isResuming: boolean;
  /** 与弹窗内预览区同一套语义（`VideoGenDialogInner` 的 `generationPhase`）。
   *  `'localQueue'` = 本机通道排队（前面还有几个任务），此时**尚未扣费**。 */
  generationPhase: 'queued' | 'generating' | 'localQueue' | null;
  /** 本机排队时排在前面的数量（仅 `'localQueue'` 用得上）。 */
  queueAhead?: number;
  /** 本次轮询开始的时刻；`null` 表示当前没有在跑的作业。 */
  jobStartedAt: number | null;
  videoUrl: string | null;
  /** 已由内层的 `translateVideoError()` 翻译好的文案（侧栏不重复实现那套映射）。 */
  errorTitle: string | null;
  errorDetail: string | null;
  /** 内层**已有**的 `combinedHistory` 条数，不新增持久化。 */
  historyCount: number;
  /** 节点是否还在当前画布上。编辑器不调 `forgetConfig`（全库零调用者），
   *  所以节点删掉后 config 仍在 —— 此时「展开」必须禁用，否则点开是个空弹窗。 */
  nodeExists: boolean;
  /** 标题行第一排：**该节点在画布上的标题**（内层用 `resolveNodeDisplayName` 取的同一份）。
   *  多窗并存时这一行可能仍然重名（默认名恒为「分镜生成」/「直出视频」），
   *  真正区分靠下一排 `subtitle`。缺省回落 `videoGen.title`。 */
  title?: string | null;
  /** 标题行第二排小字：**这一单的内容摘要**（内层从逐格描述 / 正文里摘的）。
   *  `null` ⇒ **整行不渲染**（摘不出来就不占位，别写「（无标题）」）。 */
  subtitle?: string | null;
  /** 卡片要投进去的容器（由外层 host 渲染的固定右侧列）。`null` ⇒ 不渲染。
   *  ⚠️ 必须走 portal，理由见文件头「多个小窗并存」第 2 条。 */
  container?: HTMLElement | null;
  onExpand: () => void;
  onClose: () => void;
}

export function VideoGenDock({
  isGenerating,
  isResuming,
  generationPhase,
  queueAhead = 0,
  jobStartedAt,
  videoUrl,
  errorTitle,
  errorDetail,
  historyCount,
  nodeExists,
  title,
  subtitle,
  container,
  onExpand,
  onClose,
}: VideoGenDockProps) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());

  // 只在本组件挂载时跑 —— 1 秒一跳，代价可忽略，且不影响内层的任何 state。
  useEffect(() => {
    if (!isGenerating || !jobStartedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isGenerating, jobStartedAt]);

  const phaseText = useMemo(() => {
    if (isResuming) return t('videoGen.resuming');
    if (generationPhase === 'localQueue') {
      return `${t('videoGen.localQueue')} · ${t('videoGen.queueAhead', { n: queueAhead })}`;
    }
    if (generationPhase === 'queued') return t('videoGen.queued');
    return t('videoGen.generating');
  }, [isResuming, generationPhase, queueAhead, t]);

  const elapsed = isGenerating && jobStartedAt ? formatElapsed(now - jobStartedAt) : null;
  const done = !isGenerating && !errorTitle && !!videoUrl;

  // 🔴 `VideoGenDialog` 挂在 `App.tsx` 里 `view === 'canvas'` 分支**之外**，
  // 用户点「返回」时它**不卸载**（这正合我们意 —— 卸载会 abort 轮询）。
  // 但侧栏不能跟着飘到项目页上 ⇒ 这里只隐藏自己，**内层仍保持挂载、轮询照跑**。
  const view = useProjectStore((s) => s.view);
  if (view !== 'canvas') return null;
  // 容器还没就位就不渲染。容器由外层 host 渲染且**常驻**（不随小窗数量挂卸），
  // 所以这里为 null 只可能出现在 host 自己的首帧，不会在运行中闪。
  // 与其退回「把 fixed 加回卡片上」自己瞎定位（多卡会重叠），不如这一帧什么都没有。
  if (!container) return null;

  const card = (
    <div className="w-full overflow-hidden rounded-xl border border-[rgba(255,255,255,0.12)] bg-surface-dark shadow-lg">
      {/* 标题行：第一排＝节点标题（与画布上那个节点同名），第二排＝这一单的内容摘要。
          多窗并存时第一排可能仍然重名（默认名恒为该类型名），真正区分靠第二排。 */}
      <div className="border-b border-[rgba(255,255,255,0.08)] px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2 text-xs font-semibold text-text-dark">
            <Film className={`h-3.5 w-3.5 shrink-0 ${done ? 'text-emerald-400' : 'text-purple-400'}`} />
            <span className="truncate">{title || t('videoGen.title')}</span>
          </span>
          <span className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={onExpand}
              disabled={!nodeExists}
              title={t('videoGen.dockExpand')}
              className="rounded-md p-1 text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark disabled:cursor-not-allowed disabled:opacity-30"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={onClose}
              title={t('common.close')}
              className="rounded-md p-1 text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        </div>
        {/* `pl-[22px]` = 图标 14px + `gap-2` 8px，让副标题与主标题文字左对齐。
            `title` 属性兜住被截断的那部分（鼠标悬停可看全）。 */}
        {subtitle ? (
          <p className="mt-0.5 truncate pl-[22px] text-[11px] text-text-muted" title={subtitle}>
            {subtitle}
          </p>
        ) : null}
      </div>

      <div className="space-y-2.5 px-3 py-3">
        {/* 进行中 */}
        {isGenerating && (
          <>
            <div className="flex items-center gap-2">
              <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-purple-400" />
              <span className="truncate text-xs text-text-dark">{phaseText}</span>
            </div>
            {/* 不定量：明确表达「在动、进度未知」。后端没有百分比，别在这里编一个。 */}
            <div className="h-1 w-full overflow-hidden rounded-full bg-bg-dark">
              <div className="video-dock-scan h-full w-1/3 rounded-full bg-purple-400/70" />
            </div>
            <div className="flex items-center justify-between text-[11px] text-text-muted">
              <span>
                {t('videoGen.dockWaiting')} {elapsed ?? '0:00'}
              </span>
              <span>{t('videoGen.estimateHint')}</span>
            </div>
          </>
        )}

        {/* 失败 */}
        {!isGenerating && errorTitle && (
          <div className="rounded-lg border border-red-400/30 bg-red-500/10 p-2.5">
            <p className="text-xs font-semibold text-red-400">{errorTitle}</p>
            {errorDetail && (
              <p className="ui-scrollbar mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap text-[11px] leading-relaxed text-red-300/80">
                {errorDetail}
              </p>
            )}
            <button
              type="button"
              onClick={onExpand}
              disabled={!nodeExists}
              className="mt-2 text-[11px] text-red-300 underline-offset-2 transition-colors hover:underline disabled:opacity-40"
            >
              {t('videoGen.dockExpand')}
            </button>
          </div>
        )}

        {/* 已完成 —— 醒目标记 */}
        {done && (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-400/30 bg-emerald-500/10 p-2.5">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
            <span className="flex-1 text-xs font-semibold text-emerald-300">
              {t('videoGen.dockDone')}
            </span>
            <button
              type="button"
              onClick={onExpand}
              disabled={!nodeExists}
              className="rounded-md border border-emerald-400/40 px-2 py-0.5 text-[11px] text-emerald-200 transition-colors hover:bg-emerald-500/20 disabled:opacity-40"
            >
              {t('videoGen.dockView')}
            </button>
          </div>
        )}

        {/* 空闲（既没在跑、也没成片、也没报错） */}
        {!isGenerating && !errorTitle && !videoUrl && (
          <p className="text-xs text-text-muted">{t('videoGen.dockIdle')}</p>
        )}

        {historyCount > 0 && (
          <p className="text-[11px] text-text-muted">
            {t('videoGen.dockHistoryCount', { count: historyCount })}
          </p>
        )}
      </div>
    </div>
  );

  // ⚠️ 走 portal 而不是直接返回 `card`：调用方的 React 树里本组件的位置不能变
  //    （换形态不换实例 ⇒ 轮询/成片原地保留）。见文件头「多个小窗并存」第 2 条。
  return createPortal(card, container);
}

/** 生成完成时弹一次。10 秒自动消失；**不引第三方 toast 库、不做通用化**（§4.2）。 */
export function VideoGenToast({
  message,
  onExpand,
  onDismiss,
  autoDismissMs = 10000,
}: {
  message: string;
  /** 省略时**不渲染**「查看」按钮 —— 侧栏已被用户关掉的情况下没有可展开的槽位，
   *  留一个按下去没反应的按钮比没有按钮更糟。 */
  onExpand?: () => void;
  onDismiss: () => void;
  autoDismissMs?: number;
}) {
  const { t } = useTranslation();
  const view = useProjectStore((s) => s.view);

  useEffect(() => {
    const timer = setTimeout(onDismiss, autoDismissMs);
    return () => clearTimeout(timer);
  }, [onDismiss, autoDismissMs]);

  if (view !== 'canvas') return null;

  // 定位在**底部居中**而不是右上角：右上角是侧栏的地盘，成片时两者会同时出现，
  // 叠在一起既看不清也点不准。
  return (
    <div className="fixed bottom-6 left-1/2 z-40 w-[300px] -translate-x-1/2 overflow-hidden rounded-xl border border-emerald-400/40 bg-surface-dark shadow-2xl">
      <div className="flex items-start gap-2 px-3 py-3">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-text-dark">{message}</p>
          {onExpand && (
            <button
              type="button"
              onClick={onExpand}
              className="mt-1.5 text-[11px] text-emerald-300 underline-offset-2 transition-colors hover:underline"
            >
              {t('videoGen.dockView')}
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-md p-0.5 text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
