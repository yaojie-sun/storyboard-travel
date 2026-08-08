import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Film, ImagePlus, Sparkles, X, FolderOpen, Upload, LoaderCircle } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { convertFileSrc } from '@tauri-apps/api/core';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { useAssetStore } from '@/stores/assetStore';
import { resolveImageDisplayUrl, imageUrlToDataUrl } from '@/features/canvas/application/imageData';
import { bananaSubmitVideoJob, bananaPollVideoJob, bananaCheckCredits, bananaReportUsage, bananaRefundCredits } from '@/commands/ai';
import { enhanceVideo } from '@/commands/enhance';
import { cleanVideoPrompt } from '@/commands/chat';
import { RechargeDialog } from '@/components/RechargeDialog';
import { UiModal, UiChipButton, UiButton } from '@/components/ui';
import { StoryboardPromptPicker } from './StoryboardPromptPicker';
import { useVideoGenStore } from './videoGenStore';
import { inferRefTypes, REF_TYPE_LABELS } from './refTypes';
import { fetchVideoGenRules } from './videoGenRules';
import {
  ASPECT_RATIO_OPTIONS,
  VIDEO_DURATION_OPTIONS,
  VIDEO_RESOLUTION_OPTIONS,
  computeVideoCost,
  type VideoDuration,
  type VideoResolution,
} from './videoPricing';

interface ReferenceImage {
  id: string;
  url: string;
  rawUrl: string;
}

interface ReferenceVoice {
  id: string;
  url: string;
  rawUrl: string;
  fileName: string;
}

interface DialogPayload {
  nodeId: string | null;
  initialImages: ReferenceImage[];
  initialGridFrames: string[];
  gridImageUrl?: string;
  shotFrameMap?: Record<string, unknown>;
}

// ── Outer shell — only event listener, NO store subscriptions ──

/**
 * 解析万相Wan2.7错误码，返回用户友好提示。
 * 错误来源：Rust端 `[WAN_xxx]` 前缀 + DashScope API 返回的code/message。
 * 频率最高：绿网（内容安全审核），需突出显示。
 */
function translateWanError(errorMsg: string): { title: string; detail: string } {
  const msg = errorMsg || '';
  // 本地操作（超分等）的错误直接透传，不走云端错误翻译
  if (msg.startsWith('[LOCAL]')) {
    return { title: '本地处理失败', detail: msg.slice(7).trim() };
  }
  // 提取 [WAN_xxx] 错误码（Rust端注入）
  const codeMatch = msg.match(/\[WAN_([^\]]+)\]/);
  const code = codeMatch?.[1] || '';
  const lower = msg.toLowerCase();

  // —— 内容安全审核（最高频） ——
  const 绿网Keywords = [
    '安全', '策略', '未通过', '审核', '违规', '敏感', '不合规',
    'contentnotpass', 'content_filter', 'safety', 'blocked',
    'green net', 'greennet', '100008', '100009', '100010',
    'moderation', 'rejected',
  ];
  if (绿网Keywords.some(k => lower.includes(k)) || 绿网Keywords.some(k => code.toLowerCase().includes(k))) {
    return {
      title: '内容安全审核未通过',
      detail: '本次生成的视频画面触发了网络安全审核。请返回Chat修改分镜提示词，调整画面描述后重新生成宫格图，再试一次。\n\n常见触发场景：裸露、血腥暴力、政治敏感、枪支武器、成人用品等。',
    };
  }

  // —— 速率限制 ——
  if (lower.includes('429') || lower.includes('rate') || lower.includes('限流') || lower.includes('throttl') || code.includes('rate_limit')) {
    return {
      title: '请求过于频繁',
      detail: '服务器限流中，请等待30秒后再试。积分已保留，不会重复扣费。',
    };
  }

  // —— 参数错误 ——
  if (lower.includes('invalidparameter') || lower.includes('参数') || code.includes('InvalidParameter')) {
    return {
      title: '视频参数有误',
      detail: '视频生成参数不合法。可能是分辨率、时长或参考图格式异常。请检查配置后重试。若持续出现，请联系客服。',
    };
  }

  // —— 额度不足 ——
  if (lower.includes('quota') || lower.includes('insufficient_quota') || lower.includes('额度')) {
    return {
      title: 'API 额度不足',
      detail: '服务端API资源包已用完，请联系管理员充值后重试。',
    };
  }

  // —— 服务端错误 ——
  if (lower.includes('internal') || lower.includes('500') || code.includes('internal_error')) {
    return {
      title: '服务器繁忙',
      detail: '视频生成服务暂时异常，请稍后重试。积分已返还。',
    };
  }

  // —— 网络/超时 ——
  if (lower.includes('timeout') || lower.includes('超时') || lower.includes('network') || lower.includes('网络')) {
    return {
      title: '网络连接异常',
      detail: '视频生成超时或网络中断，请检查网络后重试。积分已返还。',
    };
  }

  // —— 未知错误（显示原始信息） ——
  return {
    title: '视频生成失败',
    detail: msg.replace(/\[WAN_[^\]]+\]\s*/g, '').trim() || '未知错误，请稍后重试。',
  };
}

export function VideoGenDialog() {
  const [isOpen, setIsOpen] = useState(false);
  const [payload, setPayload] = useState<DialogPayload>({ nodeId: null, initialImages: [], initialGridFrames: [] });

  useEffect(() => {
    const unsubscribe = canvasEventBus.subscribe('video-gen-dialog/open', (p) => {
      handleOpen(p);
    });
    return unsubscribe;

    async function handleOpen(p: any) {
      const seen = new Set<string>();
      const images: ReferenceImage[] = [];
      const addImage = (rawUrl: string) => {
        if (!rawUrl || seen.has(rawUrl)) return;
        seen.add(rawUrl);
        images.push({
          id: `ref-${images.length}`,
          rawUrl,
          url: resolveImageDisplayUrl(rawUrl),
        });
      };

      const allNodes = useCanvasStore.getState().nodes;
      const allEdges = useCanvasStore.getState().edges;
      const clickedNode = allNodes.find((n: any) => n.id === p.nodeId);
      let gridFrames: string[] = [];
      let gridImageUrl: string | undefined;
      let shotFrameMap: Record<string, unknown> | undefined;
      if (clickedNode) {
        const d = clickedNode.data as any;
        gridImageUrl = d.imageUrl || d.previewImageUrl;
        shotFrameMap = d.shotFrameMap;

        // Extract per-frame grid prompts from node data (StoryboardGenNodeData.frames)
        if (Array.isArray(d.frames)) {
          gridFrames = d.frames
            .map((f: any) => f.description?.trim())
            .filter((s: string) => s && s.length > 0);
        }

        // If no frames on this node, trace edges back to find the source StoryboardGenNode
        if (gridFrames.length === 0 && clickedNode.type === 'exportImageNode') {
          // Find incoming edge: which node connects TO this export node
          const incomingEdge = allEdges.find((e: any) => e.target === p.nodeId);
          if (incomingEdge) {
            const sourceNode = allNodes.find((n: any) => n.id === incomingEdge.source);
            if (sourceNode && Array.isArray((sourceNode.data as any).frames)) {
              gridFrames = ((sourceNode.data as any).frames as any[])
                .map((f: any) => f.description?.trim())
                .filter((s: string) => s && s.length > 0);
              // Also pull shotFrameMap from the source StoryboardGenNode
              if (!shotFrameMap) {
                shotFrameMap = (sourceNode.data as any).shotFrameMap;
              }
            }
          }
        }

        // 直接调入宫格图，不分割（万相故事板模式）
        if (gridImageUrl) {
          addImage(gridImageUrl);
        } else {
          (p.images || []).forEach((url: string) => addImage(url));
          if (d.previewImageUrl) addImage(d.previewImageUrl);
          if (d.imageUrl && d.imageUrl !== d.previewImageUrl) addImage(d.imageUrl);
        }
      } else {
        (p.images || []).forEach((url: string) => addImage(url));
      }

      setPayload({
        nodeId: p.nodeId ?? null,
        initialImages: images.slice(0, 5),
        initialGridFrames: gridFrames,
        gridImageUrl,
        shotFrameMap,
      });
      setIsOpen(true);
    }
  }, []);

  const handleClose = useCallback(() => setIsOpen(false), []);

  if (!isOpen) return null;

  return (
    <VideoGenDialogInner
        nodeId={payload.nodeId}
        initialImages={payload.initialImages}
        initialGridFrames={payload.initialGridFrames}
        gridImageUrl={payload.gridImageUrl}
        shotFrameMap={payload.shotFrameMap}
        onClose={handleClose}
      />
  );
}

// ── Inner dialog — all store subscriptions, only mounted when open ──

const EMPTY_ASSETS: any[] = [];

function VideoGenDialogInner({
  nodeId,
  initialImages,
  initialGridFrames,
  gridImageUrl,
  shotFrameMap: _shotFrameMap, // 保留但不再注入图N引用
  onClose,
}: {
  nodeId: string | null;
  initialImages: ReferenceImage[];
  initialGridFrames: string[];
  gridImageUrl?: string;
  shotFrameMap?: Record<string, unknown>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const assets = useAssetStore((s) => (currentProjectId ? s.getAssets(currentProjectId) : EMPTY_ASSETS));
  const loadAssets = useAssetStore((s) => s.loadAssets);
  const saveConfig = useVideoGenStore((s) => s.saveConfig);
  const addToHistory = useVideoGenStore((s) => s.addToHistory);
  const forcePersistVideoGen = useVideoGenStore((s) => s.forcePersist);

  // Subscribe to store so savedConfig reactively updates after hydration
  const savedConfig = useVideoGenStore((s) => (nodeId ? s.configs[nodeId] : null) ?? null);
  const hydrated = useVideoGenStore((s) => s._hydrated);

  // Sync saved config into local state
  // seededRef 标记"已完成种子化检查"，无论有无已存 config 都要置 true，
  // 这样才能让 auto-save 在新节点（无历史 config）场景下正常启动。
  const seededRef = useRef(false);
  useEffect(() => {
    // DEBUG: 简洁对比
    try {
      const allConfigKeys = Object.keys(useVideoGenStore.getState().configs ?? {});
      console.log('[VideoGenDialog][DEBUG] nodeId:', nodeId, 'savedConfig:', !!savedConfig);
      console.log('[VideoGenDialog][DEBUG] config keys 前5:', allConfigKeys.slice(0, 5));
      console.log('[VideoGenDialog][DEBUG] nodeId在configKeys中?', nodeId ? allConfigKeys.includes(nodeId) : false);
      console.log('[VideoGenDialog][DEBUG] configKeys总数:', allConfigKeys.length);
    } catch {};
    if (!hydrated) return;
    if (seededRef.current) return;
    seededRef.current = true;
    if (!savedConfig) return;
    if (savedConfig.prompt) setPrompt(savedConfig.prompt);
    if (savedConfig.aspectRatio) setAspectRatio(savedConfig.aspectRatio);
    if (savedConfig.duration) setDuration(savedConfig.duration);
    if (savedConfig.videoUrl) setVideoUrl(savedConfig.videoUrl);
    if (savedConfig.pendingTaskId) setPendingTaskId(savedConfig.pendingTaskId);
    if (savedConfig.pendingCreditsDeducted) setCreditsDeducted(savedConfig.pendingCreditsDeducted);
    if (savedConfig.referenceImageUrls?.length && initialImages.length === 0) {
      setReferenceImages(savedConfig.referenceImageUrls);
    }
    if (savedConfig.referenceVoice) setReferenceVoice(savedConfig.referenceVoice);
    if (savedConfig.gridFrames?.length && initialGridFrames.length === 0) {
      setGridFrames(savedConfig.gridFrames);
    }
  }, [hydrated, savedConfig]);

  // 参考图：有宫格图传入时直接覆盖，不合并旧缓存
  const initRefImages = useMemo(() => {
    if (initialImages.length > 0) return initialImages;
    const saved = savedConfig?.referenceImageUrls;
    return saved && saved.length > 0 ? saved : [];
  }, [savedConfig?.referenceImageUrls, initialImages]);

  const [aspectRatio, setAspectRatio] = useState('9:16');
  const [resolution, setResolution] = useState<VideoResolution>('720P');
  const [duration, setDuration] = useState<VideoDuration>(4);
  const [videoModel] = useState<string>('happyhorse/happyhorse-1.1-r2v');
  const [prompt, setPrompt] = useState('');
  const [gridFrames, setGridFrames] = useState<string[]>(initialGridFrames);

  const [referenceImages, setReferenceImages] = useState<ReferenceImage[]>(initRefImages);
  const [referenceVoice, setReferenceVoice] = useState<ReferenceVoice | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  // 本地路径需转为 Tauri asset URL 才能在 webview 中播放
  const displayVideoUrl = useMemo(() => {
    if (!videoUrl) return null;
    if (videoUrl.startsWith('http')) return videoUrl;
    return convertFileSrc(videoUrl);
  }, [videoUrl]);
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const [creditsDeducted, setCreditsDeducted] = useState<number>(0);

  // 任何参数变化时自动持久化（统一入口，避免多个 effect 互相覆盖）
  // 首次挂载时跳过：等 state 从 savedConfig 种子化完成后再启用，防止空默认值覆盖已有数据
  const autoSaveArmedRef = useRef(false);
  useEffect(() => {
    if (!nodeIdRef.current) return;
    if (!autoSaveArmedRef.current) {
      // 种子化完成后才启用自动保存
      if (hydrated && seededRef.current) {
        autoSaveArmedRef.current = true;
      }
      return;
    }
    const timer = setTimeout(() => {
      // 防止空配置覆盖已有数据：无 prompt、无 videoUrl、无进行中任务时不保存
      if (!prompt.trim() && !videoUrl && !pendingTaskId) return;
      // 合并已有配置，防止本地 null 值覆盖存储中已有数据
      var existingCfg = useVideoGenStore.getState().configs[nodeIdRef.current!];
      saveConfig(nodeIdRef.current!, {
        prompt,
        aspectRatio,
        resolution,
        duration,
        videoModel,
        videoUrl: videoUrl ?? existingCfg?.videoUrl,
        referenceImageUrls: referenceImages.map(({ id, rawUrl, url }) => ({ id, rawUrl, url })),
        referenceVoice: referenceVoice ?? existingCfg?.referenceVoice,
        pendingTaskId: pendingTaskId ?? existingCfg?.pendingTaskId,
        pendingCreditsDeducted: creditsDeducted || existingCfg?.pendingCreditsDeducted,
        gridFrames: gridFrames.length > 0 ? gridFrames : existingCfg?.gridFrames,
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [prompt, aspectRatio, duration, videoModel, videoUrl, referenceImages, referenceVoice, pendingTaskId, creditsDeducted, saveConfig, hydrated]);

  const [isGenerating, setIsGenerating] = useState(false);
  const [isResuming, setIsResuming] = useState(false);
  const [isUpscaling, setIsUpscaling] = useState(false);
  const [upscaleTarget, setUpscaleTarget] = useState<'2K' | '4K' | null>(null);
  const [showUpscaleConfirm, setShowUpscaleConfirm] = useState(false);
  const [isLocalEnhancing, setIsLocalEnhancing] = useState(false);
  const [localEnhanceProgress, setLocalEnhanceProgress] = useState(0); // 0-100
  const [showLocalEnhanceConfirm, setShowLocalEnhanceConfirm] = useState(false);
  const enhanceSuppressVideoConfirmRef = useRef(
    localStorage.getItem('enhance:suppressVideoConfirm') === '1',
  );
  const [error, setError] = useState<string | null>(null);
  const pollAbortRef = useRef<AbortController | null>(null);
  const submitParamsRef = useRef<{ aspectRatio: string; duration: number; videoModel: string; refUrls: string[]; negativePrompt?: string } | null>(null);
  const retryCountRef = useRef(0);
  const [showPromptPicker, setShowPromptPicker] = useState(false);
  // @图 picker 已移除：分镜提示词不可手动修改
  const showPromptPickerRef = useRef(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [showAssetPicker, setShowAssetPicker] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [showInsufficientDialog, setShowInsufficientDialog] = useState(false);
  const [insufficientRequired, setInsufficientRequired] = useState(0);
  const [insufficientCurrent, setInsufficientCurrent] = useState(0);
  const [showRecharge, setShowRecharge] = useState(false);
  const historyRef = useRef<HTMLDivElement | null>(null);
  const [assetPickerSelected, setAssetPickerSelected] = useState<Set<string>>(new Set());
  const addMenuRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement | null>(null);
  const nodeIdRef = useRef(nodeId);
  nodeIdRef.current = nodeId;

  showPromptPickerRef.current = showPromptPicker;

  // ── 轮询任务直到完成或失败 ──
  const startPolling = useCallback(async (taskId: string, _isResume: boolean, deducted: number = 0, modelName?: string) => {
    // 先中止已有的轮询，防止并发
    if (pollAbortRef.current) {
      pollAbortRef.current.abort();
    }
    const POLL_INTERVAL = 3000;
    const MAX_POLL_MS = 100 * 60 * 1000; // 100 minutes
    const startTime = Date.now();
    const controller = new AbortController();
    pollAbortRef.current = controller;

    try {
      while (true) {
        if (controller.signal.aborted) return;
        await new Promise((r) => setTimeout(r, POLL_INTERVAL));
        if (controller.signal.aborted) return;

        try {
          const pollResult = await bananaPollVideoJob(taskId, deducted, modelName);
          if (controller.signal.aborted) return;
          if (pollResult.status === 'succeeded' && pollResult.videoUrl) {
            setVideoUrl(pollResult.videoUrl);
            // 自动下载视频到本地，优先使用本地路径
            let localVideoPath = pollResult.videoUrl;
            try {
              const { invoke } = await import('@tauri-apps/api/core');
              localVideoPath = await invoke<string>('download_video_to_local', {
                url: pollResult.videoUrl,
                filename: `video_${Date.now()}.mp4`,
              });
              console.log('[VideoGenDialog] video saved to:', localVideoPath);
            } catch (downloadErr) {
              console.warn('[VideoGenDialog] auto-download failed:', downloadErr);
            }
            const config = {
              prompt: prompt.trim() || '',
              aspectRatio,
              duration,
              videoModel,
              videoUrl: localVideoPath,
              referenceImageUrls: referenceImages.map(({ id, rawUrl, url }) => ({ id, rawUrl, url })),
              referenceVoice: referenceVoice ?? undefined,
              gridFrames: gridFrames.length > 0 ? gridFrames : undefined,
            };
            if (nodeIdRef.current) {
              saveConfig(nodeIdRef.current, config);
              addToHistory(nodeIdRef.current, config, taskId);
              // 视频生成成功，立即持久化到本地文件
              forcePersistVideoGen().catch((e) => console.warn('[VideoGenDialog] force persist failed:', e));
              // 更新画布节点数据，让视频在节点上可见
              try {
                useCanvasStore.getState().updateNodeData(nodeIdRef.current, {
                  generatedVideoUrl: localVideoPath,
                });
              } catch { /* non-critical */ }
            }
            setIsGenerating(false);
            setIsResuming(false);
            bananaReportUsage({ api_type: 'pixverse_c1', is_success: true, cost_credits: deducted, response_time_ms: Date.now() - startTime, category: 'video_generation', image_size: aspectRatio, duration_seconds: duration, prompt_len: prompt.length, error_message: '' }).catch(() => {});
            return;
          }
          if (pollResult.status === 'failed' || pollResult.status === 'retry') {
            setError(pollResult.error || t('videoGen.generationFailed', '视频生成失败，积分已返还，请稍后重试'));
            if (nodeIdRef.current) {
              saveConfig(nodeIdRef.current, {
                prompt: prompt.trim() || '',
                aspectRatio,
                duration,
                videoModel,
                pendingTaskId: undefined,
                pendingCreditsDeducted: undefined,
                referenceImageUrls: referenceImages.map(({ id, rawUrl, url }) => ({ id, rawUrl, url })),
                referenceVoice: referenceVoice ?? undefined,
                gridFrames: gridFrames.length > 0 ? gridFrames : undefined,
              });
            }
            setIsGenerating(false);
            setIsResuming(false);
            return;
          }
          // running → continue polling
          // 后端可能在 polling 中返回 error 字段（如网络波动），记录日志帮助排查
          if (pollResult.error) {
            console.warn('[VideoGenDialog] poll returned running with error:', pollResult.error);
          }
          if (Date.now() - startTime > MAX_POLL_MS) {
            // 超时退费
            if (deducted > 0) {
              bananaRefundCredits(deducted, `video_timeout:${modelName || 'unknown'}`).catch(() => {});
            }
            setError(t('videoGen.pollTimeout', '视频生成超时，积分已返还，请稍后重试'));
            setIsGenerating(false);
            setIsResuming(false);
            bananaReportUsage({ api_type: 'pixverse_c1', is_success: false, cost_credits: deducted, response_time_ms: Date.now() - startTime, category: 'video_generation', image_size: aspectRatio, duration_seconds: duration, prompt_len: prompt.length, error_message: 'timeout' }).catch(() => {});
            return;
          }
        } catch (e) {
          // 网络错误退费
          if (deducted > 0) {
            bananaRefundCredits(deducted, `video_network_error:${modelName || 'unknown'}`).catch(() => {});
          }
          setError(t('videoGen.networkError', '网络异常，积分已返还，请检查网络后重试'));
          setIsGenerating(false);
          setIsResuming(false);
          bananaReportUsage({ api_type: 'pixverse_c1', is_success: false, cost_credits: deducted, response_time_ms: Date.now() - startTime, category: 'video_generation', image_size: aspectRatio, duration_seconds: duration, prompt_len: prompt.length, error_message: 'network_error' }).catch(() => {});
          return;
        }
      }
    } finally {
      if (pollAbortRef.current === controller) {
        pollAbortRef.current = null;
      }
    }
  }, [prompt, aspectRatio, duration, referenceImages, saveConfig, addToHistory, t]);

  // 重进页面时：有 pendingTaskId 但无 videoUrl → 自动续接
  useEffect(() => {
    const pid = savedConfig?.pendingTaskId;
    if (pid && !savedConfig?.videoUrl) {
      console.log('[VideoGenDialog] resuming pending task:', pid);
      // PixVerse/BP tasks expire across sessions — don't auto-resume
      // Only PixVerse/BP (non-happyhorse) tsk- tasks expire across sessions.
      // HappyHorse 1.1 via BaiduVOD also uses tsk- prefix — these MUST auto-resume.
      const isHappyhorseTask = savedConfig?.videoModel?.includes('happyhorse');
      if (pid.startsWith('tsk-') && !isHappyhorseTask) {
        console.log('[VideoGenDialog] skipping PixVerse resume (task expires across sessions)');
        setPendingTaskId(null);
        return;
      }
      const resumeModel = savedConfig?.videoModel
        ? (savedConfig.videoModel.includes('happyhorse')
            ? 'happyhorse/happyhorse-1.1-r2v'
            : savedConfig.videoModel.includes('pixverse')
              ? 'pixverse/c1'
              : 'wan/wan2.7-r2v')
        : undefined;
      setIsResuming(true);
      setIsGenerating(true);
      startPolling(pid, true, savedConfig?.pendingCreditsDeducted ?? 0, resumeModel);
    }
    // 组件卸载时中止轮询，防止旧轮询循环在后台继续运行
    return () => {
      if (pollAbortRef.current) {
        pollAbortRef.current.abort();
        pollAbortRef.current = null;
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const isHappyhorse = videoModel.includes('happyhorse');
  const isWan = videoModel.includes('wan');
  const isPixverse = videoModel.includes('pixverse');

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  const handleSelectPrompt = useCallback((selectedPrompt: string, frames?: string[]) => {
    // 去除 @图N 引用——C1 Fusion 模式使用宫格图作参考，@图N 语法无效
    const cleaned = selectedPrompt.replace(/@图\d+[的所示中指]*/g, '').replace(/  +/g, ' ').trim();
    setPrompt(cleaned);
    if (frames?.length) setGridFrames(frames);
    setShowPromptPicker(false);
  }, []);

  // handlePromptChange 和 handlePromptKeyDown 已移除：分镜提示词不可手动修改

  // ── 添加参考图菜单 ──

  useEffect(() => {
    if (!addMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (addMenuRef.current?.contains(event.target as Node)) return;
      setAddMenuOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [addMenuOpen]);

  const handleLocalUpload = useCallback(async () => {
    setAddMenuOpen(false);
    try {
      const selected = await open({
        multiple: true,
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      const newImages: ReferenceImage[] = paths.map((path) => ({
        id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        rawUrl: convertFileSrc(path),
        url: convertFileSrc(path),
      }));
      setReferenceImages((prev) => [...prev, ...newImages].slice(0, maxImages));
    } catch (e) {
      console.error('[VideoGenDialog] local upload failed:', e);
    }
  }, []);

  const handleOpenAssetPicker = useCallback(async () => {
    setAddMenuOpen(false);
    if (currentProjectId) {
      await loadAssets(currentProjectId);
    }
    setAssetPickerSelected(new Set());
    setShowAssetPicker(true);
  }, [currentProjectId, loadAssets]);

  const handleConfirmAssetImport = useCallback(() => {
    const seenRawUrls = new Set(referenceImages.map((i) => i.rawUrl));
    const newImages: ReferenceImage[] = [];

    for (const assetId of assetPickerSelected) {
      const asset = assets.find((a: any) => a.id === assetId);
      if (!asset) continue;
      const rawUrl = convertFileSrc(asset.filePath);
      if (seenRawUrls.has(rawUrl)) continue;
      seenRawUrls.add(rawUrl);
      newImages.push({
        id: asset.id,
        rawUrl,
        url: rawUrl,
      });
    }

    if (newImages.length > 0) {
      setReferenceImages((prev) => [...prev, ...newImages].slice(0, maxImages));
    }
    setShowAssetPicker(false);
    setAssetPickerSelected(new Set());
  }, [assetPickerSelected, assets, referenceImages]);

  const toggleAssetSelection = useCallback((id: string) => {
    setAssetPickerSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleRemoveImage = useCallback((id: string) => {
    setReferenceImages((prev) => prev.filter((img) => img.id !== id));
  }, []);


  const maxImages = 5;
  const creditCost = computeVideoCost(duration, resolution, false);
  // 订阅整个 history 引用，用 useMemo 稳定返回值避免空数组无限渲染
  const historyStore = useVideoGenStore((s) => s.history);
  const historyEntries = useMemo(() => {
    if (!nodeId) return [];
    const entries = historyStore[nodeId];
    return entries ?? [];
  }, [historyStore, nodeId]);

  // 正在生成的任务也列入历史（放在最前面，标注"正在生成"）
  const activeGeneratingEntry = isGenerating && pendingTaskId
    ? { id: '__active__', prompt, aspectRatio, duration, createdAt: Date.now(), taskId: pendingTaskId, videoUrl: null as string | null, _generating: true as const }
    : null;

  // 历史列表 = 正在生成(最前) + 已完成记录
  const combinedHistory = useMemo(() => {
    const completed = historyEntries.map((e) => ({ ...e, _generating: false as const }));
    return activeGeneratingEntry ? [activeGeneratingEntry, ...completed] : completed;
  }, [historyEntries, activeGeneratingEntry]);

  // Close history popover on click outside
  useEffect(() => {
    if (!showHistory) return;
    const onPointerDown = (event: PointerEvent) => {
      if (historyRef.current?.contains(event.target as Node)) return;
      setShowHistory(false);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [showHistory]);

  const refMetas = useMemo(
    () => inferRefTypes(prompt, referenceImages.length),
    [prompt, referenceImages.length],
  );

  const handleGenerate = useCallback(async () => {
    setError(null);

    // 检查积分
    try {
      const creditsInfo = await bananaCheckCredits();
      const cost = computeVideoCost(duration, resolution, false);
      if (creditsInfo.credits < cost) {
        setInsufficientRequired(cost);
        setInsufficientCurrent(creditsInfo.credits);
        setShowInsufficientDialog(true);
        return;
      }
    } catch (e: any) {
      setError(e?.message || '无法检查积分，请重试');
      return;
    }

    setShowConfirmDialog(true);
  }, [prompt, referenceImages, duration, t]);

  const executeGenerate = useCallback(async () => {
    setShowConfirmDialog(false);
    setError(null);

    // 校验：必须有故事板提示词
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      setError(t('videoGen.emptyPrompt', '请先在提示词框中输入或选择分镜提示词'));
      return;
    }

    setIsGenerating(true);
    setVideoUrl(null);

    try {
      // 1. 获取规则文件
      const rules = await fetchVideoGenRules(videoModel);

      // 2. DeepSeek 清洗：去掉光影/场景/外观，只保留运镜+精简动作+声音
      //    确保文字描述不超出宫格图已锚定的画面内容（第3锁）
      let userContent = trimmedPrompt;
      if (isWan || isHappyhorse) {
        try {
          userContent = await cleanVideoPrompt({
            storyboardPrompt: trimmedPrompt,
            gridFrames,
            targetModel: isHappyhorse ? 'happyhorse' : 'wan',
            referenceImages: referenceImages.map(img => img.rawUrl),
          });
          console.log('[VideoGenDialog] DeepSeek cleaned prompt:', userContent.length, 'chars (was:', trimmedPrompt.length, 'chars)');
        } catch (e) {
          console.warn('[VideoGenDialog] DeepSeek cleaning failed, using original prompt:', e);
        }
      }

      // 2.5 shotFrameMap 保留在节点缓存中（用于后续分析/调试），
      // 但不再注入图N引用到 prompt。
      // 官方文档：Wan2.7 R2V 自动识别宫格逻辑，"无需描述每个宫格"。
      // 让模型从整张六宫格图中自行匹配帧，避免指定图N干扰模型判断。

      let finalPrompt: string;

      // 3. 规则头：从 video_gen_rules_{model}.json 注入（服务端热更新，不需重构建）
      const promptRule = rules.prompt_rule ?? '';
      const negativePrompt = rules.negative_prompt ?? '';
      const guidanceScale = rules.guidance_scale;
      const shotType = rules.shot_type;

      // Wan 模型画面锁定尾句（代码层 100% 可靠追加，AI 无法遗忘）
      finalPrompt = promptRule
        ? `${promptRule}\n\n${userContent}`
        : userContent;
      console.log(`[VideoGenDialog] ${isPixverse ? 'PixVerse' : isWan ? 'Wan' : 'HappyHorse'}, refs:`, referenceImages.length, 'hasRule:', !!promptRule, 'hasNegPrompt:', !!negativePrompt, 'guidanceScale:', guidanceScale, 'shotType:', shotType, 'promptLen:', finalPrompt.length);

      // 4. 准备参考图 — 直接用 base64
      const imageInput: string[] = [];
      if (isWan && gridImageUrl) {
        // 万相：直接传入整张六宫格大图（不拆分）
        try {
          const dataUrl = gridImageUrl.startsWith('data:')
            ? gridImageUrl
            : await imageUrlToDataUrl(resolveImageDisplayUrl(gridImageUrl));
          imageInput.push(dataUrl);
        } catch (e) {
          console.warn('[VideoGenDialog] Wan: failed to convert grid image:', gridImageUrl, e);
        }
      } else {
        // 欢乐马：传入拆分后的六张独立参考图
        for (const img of referenceImages) {
          try {
            const dataUrl = img.rawUrl.startsWith('data:')
              ? img.rawUrl
              : await imageUrlToDataUrl(img.url);
            imageInput.push(dataUrl);
          } catch (e) {
            console.warn('[VideoGenDialog] failed to convert to base64:', img.rawUrl, e);
          }
        }
      }

      // 准备音色参考 audio data URL
      let voiceUrl: string | undefined;
      if (referenceVoice && (isHappyhorse || isWan)) {
        try {
          const rawUrl = referenceVoice.rawUrl;
          if (rawUrl.startsWith('data:')) {
            voiceUrl = rawUrl;
          } else {
            // Read audio file via fetch + FileReader → base64 data URL
            const response = await fetch(rawUrl);
            const blob = await response.blob();
            voiceUrl = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result as string);
              reader.onerror = () => reject(new Error('Failed to read audio file'));
              reader.readAsDataURL(blob);
            });
          }
        } catch (e) {
          console.warn('[VideoGenDialog] failed to read voice file:', e);
        }
      }

      // 5. 提交视频任务（非阻塞，拿到 taskId 后轮询）
      const result = await bananaSubmitVideoJob({
        prompt: finalPrompt,
        aspectRatio,
        resolution,
        durationSeconds: duration,
        imageInput,
        voiceUrl,
        negativePrompt: negativePrompt || undefined,
        guidanceScale,
        shotType,
        model: isHappyhorse
          ? 'happyhorse/happyhorse-1.1-r2v'
          : isPixverse
            ? 'pixverse/c1'
            : 'wan/wan2.7-r2v',
      });

      if (result.success) {
        const deducted = result.creditsDeducted ?? 0;
        if (deducted > 0) setCreditsDeducted(deducted);
        // 保存提交参数供 429 重试用
        retryCountRef.current = 0;
        submitParamsRef.current = {
          aspectRatio,
          duration,
          videoModel,
          refUrls: referenceImages.map((img) => img.rawUrl),
          negativePrompt,
        };
        if (result.videoUrl) {
          // 同步完成（罕见），也下载到本地
          setVideoUrl(result.videoUrl);
          let syncVideoPath = result.videoUrl;
          try {
            const { invoke: invokeSync } = await import('@tauri-apps/api/core');
            syncVideoPath = await invokeSync<string>('download_video_to_local', {
              url: result.videoUrl,
              filename: `video_${Date.now()}.mp4`,
            });
          } catch (downloadErr) {
            console.warn('[VideoGenDialog] sync video download failed:', downloadErr);
          }
          const config = {
            prompt: prompt.trim() || '',
            aspectRatio,
            duration,
            videoModel,
            videoUrl: syncVideoPath,
            referenceImageUrls: referenceImages.map(({ id, rawUrl, url }) => ({ id, rawUrl, url })),
            referenceVoice: referenceVoice ?? undefined,
            gridFrames: gridFrames.length > 0 ? gridFrames : undefined,
          };
          if (nodeIdRef.current) {
            saveConfig(nodeIdRef.current, config);
            addToHistory(nodeIdRef.current, config, result.taskId || undefined);
            try {
              useCanvasStore.getState().updateNodeData(nodeIdRef.current, {
                generatedVideoUrl: syncVideoPath,
              });
            } catch { /* non-critical */ }
          }
          setIsGenerating(false);
        } else if (result.taskId) {
          // 异步任务，存储 taskId 开始轮询
          setPendingTaskId(result.taskId);
          if (nodeIdRef.current) {
            saveConfig(nodeIdRef.current, {
              prompt: prompt.trim(),
              aspectRatio,
              duration,
              pendingTaskId: result.taskId,
              pendingCreditsDeducted: deducted,
              referenceImageUrls: referenceImages.map(({ id, rawUrl, url }) => ({ id, rawUrl, url })),
            });
          }
          startPolling(result.taskId, false, deducted, isHappyhorse
            ? 'happyhorse/happyhorse-1.1-r2v'
            : isPixverse
              ? 'pixverse/c1'
              : 'wan/wan2.7-r2v');
        } else {
          setIsGenerating(false);
          setError(t('videoGen.unknownError', '未知错误'));
        }
      } else if (result.error) {
        setIsGenerating(false);
        if (result.error.startsWith('INSUFFICIENT_CREDITS')) {
          setInsufficientRequired(result.requiredCredits ?? computeVideoCost(duration, resolution, false));
          setInsufficientCurrent(result.currentCredits ?? 0);
          setShowInsufficientDialog(true);
        } else {
          setError(result.error);
        }
      } else {
        setIsGenerating(false);
        setError(t('videoGen.unknownError', '未知错误'));
      }
    } catch (e: any) {
      setIsGenerating(false);
      setError(e?.message || e?.toString() || t('videoGen.unknownError', '未知错误'));
    }
    // 注意：不在 finally 中 setIsGenerating(false)，轮询函数会在完成/失败时设置
  }, [prompt, aspectRatio, duration, videoModel, referenceImages, t, saveConfig, addToHistory, startPolling]);

  // 对话框关闭时强制落盘，防止防抖窗口内数据丢失
  useEffect(() => {
    return () => {
      forcePersistVideoGen().catch(() => {});
    };
  }, []);

  const handleLocalEnhance = useCallback(async () => {
    if (!videoUrl) return;
    setIsLocalEnhancing(true);
    setLocalEnhanceProgress(0);
    setError(null);
    // 模拟进度条：0→90% 约 3 分钟，完成后跳到 100%
    const progressTimer = setInterval(() => {
      setLocalEnhanceProgress(prev => {
        if (prev >= 90) return prev;
        const increment = Math.random() * 6 + 2; // 2-8% per tick
        return Math.min(90, prev + increment);
      });
    }, 2500);
    try {
      const result = await enhanceVideo(videoUrl, 2);
      setLocalEnhanceProgress(100);
      setVideoUrl(result);
      // 立即持久化，不走防抖，避免关弹窗丢数据
      const existingCfg = useVideoGenStore.getState().configs[nodeIdRef.current!];
      saveConfig(nodeIdRef.current!, {
        prompt,
        aspectRatio,
        resolution,
        duration,
        videoModel,
        videoUrl: result,
        referenceImageUrls: referenceImages.map(({ id, rawUrl, url }) => ({ id, rawUrl, url })),
        referenceVoice: referenceVoice ?? existingCfg?.referenceVoice,
        gridFrames: gridFrames.length > 0 ? gridFrames : existingCfg?.gridFrames,
      });
      if (nodeIdRef.current) {
        addToHistory(nodeIdRef.current, {
          prompt: '【本地4K】' + (prompt?.trim() || ''),
          aspectRatio,
          duration,
          videoModel,
          videoUrl: result,
          referenceImageUrls: referenceImages.map(({ id, rawUrl, url }) => ({ id, rawUrl, url })),
          referenceVoice: referenceVoice ?? undefined,
          gridFrames: gridFrames.length > 0 ? gridFrames : undefined,
        });
      }
    } catch (e: any) {
      setError('[LOCAL] ' + (e?.message || String(e)));
    } finally {
      clearInterval(progressTimer);
      setIsLocalEnhancing(false);
    }
  }, [videoUrl, prompt, aspectRatio, duration, videoModel, referenceImages, referenceVoice, gridFrames, addToHistory]);

  return (
    <div className="fixed inset-0 z-[140] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="flex h-[92vh] max-h-[900px] w-[1100px] max-w-[95vw] overflow-hidden rounded-2xl border border-[rgba(255,255,255,0.12)] bg-surface-dark shadow-2xl">
        {/* Left panel: parameters */}
        <div className="flex w-[420px] shrink-0 flex-col border-r border-[rgba(255,255,255,0.08)]">
          <div className="flex items-center justify-between border-b border-[rgba(255,255,255,0.08)] px-5 py-3.5">
            <h2 className="flex items-center gap-2 text-base font-semibold text-text-dark">
              <Film className="h-4 w-4 text-purple-400" />
              {t('videoGen.title', '视频生成')}
            </h2>
            <button
              type="button"
              onClick={handleClose}
              className="rounded-lg p-1.5 text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="ui-scrollbar flex-1 space-y-5 overflow-y-auto p-5">
            {/* Aspect ratio */}
            <div>
              <label className="mb-1.5 block text-xs font-medium text-text-muted">
                {t('videoGen.aspectRatio', '画幅')}
              </label>
              <select
                value={aspectRatio}
                onChange={(e) => setAspectRatio(e.target.value)}
                className="h-9 w-full rounded-lg border border-[rgba(255,255,255,0.12)] bg-bg-dark px-3 text-sm text-text-dark focus:outline-none focus:ring-1 focus:ring-purple-400/50"
              >
                {ASPECT_RATIO_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Resolution — 暂时隐藏，默认720P */}
            {false && (<div>
              <label className="mb-1.5 block text-xs font-medium text-text-muted">
                {t('videoGen.resolution', '分辨率')}
              </label>
              <div className="flex gap-2">
                {VIDEO_RESOLUTION_OPTIONS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setResolution(r)}
                    className={`flex-1 rounded-lg border py-2 text-sm font-medium transition-colors ${
                      resolution === r
                        ? 'border-purple-400/60 bg-purple-500/20 text-purple-200'
                        : 'border-[rgba(255,255,255,0.1)] bg-bg-dark text-text-muted hover:border-purple-400/30'
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>)}

            {/* Duration */}
            <div>
              <label className="mb-2 block text-xs font-medium text-text-muted">
                {t('videoGen.duration', '时长')}
              </label>
              <div className="flex gap-2">
                {VIDEO_DURATION_OPTIONS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDuration(d)}
                    className={`flex-1 rounded-lg border py-2 text-sm font-medium transition-colors ${
                      duration === d
                        ? 'border-purple-400/60 bg-purple-500/20 text-purple-200'
                        : 'border-[rgba(255,255,255,0.1)] bg-bg-dark text-text-muted hover:border-purple-400/30'
                    }`}
                  >
                    {d}s
                  </button>
                ))}
              </div>
            </div>

            {/* Prompt */}
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label className="text-xs font-medium text-text-muted">
                  {t('videoGen.prompt', '提示词')}
                </label>
                <button
                  type="button"
                  onClick={() => setShowPromptPicker(true)}
                  className="text-xs text-purple-400 hover:text-purple-300 transition-colors"
                >
                  {t('videoGen.extractFromStoryboard', '从分镜提取')}
                </button>
              </div>

              <div className="relative">
                {/* 高亮叠加层：只对 @图N 着色，其余透明，露出下方 textarea 文字 */}
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 z-10 overflow-hidden whitespace-pre-wrap rounded-lg border border-transparent px-3 py-2 text-sm"
                  style={{ fontFamily: 'inherit', lineHeight: '1.5', wordBreak: 'break-word' }}
                  ref={(el) => { highlightRef.current = el; }}
                >
                  {prompt
                    ? prompt.split(/(@图\d+)/g).map((part, i) =>
                        /^@图\d+$/.test(part) ? (
                          <mark key={i} className="rounded-sm bg-purple-500/20 text-purple-300 font-medium">
                            {part}
                          </mark>
                        ) : (
                          <span key={i} className="text-transparent">{part}</span>
                        ),
                      )
                    : null}
                </div>
                <textarea
                  ref={textareaRef}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder={t('videoGen.promptPlaceholder', '描述你想要生成的视频内容...')}
                  rows={13}
                  className="relative w-full resize-none rounded-lg border border-[rgba(255,255,255,0.12)] bg-transparent px-3 py-2 text-sm placeholder-text-muted focus:outline-none"
                  style={{ lineHeight: '1.5', wordBreak: 'break-word' }}
                  onScroll={(e) => {
                    const hl = highlightRef.current;
                    if (hl) hl.scrollTop = (e.target as HTMLTextAreaElement).scrollTop;
                  }}
                />
              </div>
            </div>

            {/* Reference images */}
            <div>
              <label className="mb-2 block text-xs font-medium text-text-muted">
                {t('videoGen.referenceImages', '参考图')}{' '}
                <span className="text-text-muted/60">
                  ({referenceImages.length}/{maxImages})
                </span>
              </label>
              <div className="flex flex-wrap gap-2">
                {referenceImages.map((img, i) => {
                  const meta = refMetas[i];
                  return (
                  <div key={img.id} className="group relative">
                    <img
                      src={img.url}
                      alt=""
                      className="h-16 w-16 rounded-lg border border-[rgba(255,255,255,0.1)] object-cover"
                    />
                    {meta && (
                      <span className={`absolute -bottom-1.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded px-1.5 py-0.5 text-[9px] font-medium ${
                        meta.type === 'storyboard' ? 'bg-amber-500/80 text-amber-950' :
                        meta.type === 'character' ? 'bg-blue-500/80 text-blue-950' :
                        meta.type === 'scene' ? 'bg-emerald-500/80 text-emerald-950' :
                        meta.type === 'clothing' ? 'bg-pink-500/80 text-pink-950' :
                        'bg-zinc-500/80 text-zinc-200'
                      }`}>
                        {REF_TYPE_LABELS[meta.type]}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => handleRemoveImage(img.id)}
                      className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-red-500/80 text-white opacity-0 transition-opacity group-hover:opacity-100"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                  );
                })}
                {referenceImages.length < maxImages && (
                  <div ref={addMenuRef} className="relative">
                    <button
                      type="button"
                      onClick={() => setAddMenuOpen((v) => !v)}
                      className="flex h-16 w-16 items-center justify-center rounded-lg border border-dashed border-[rgba(255,255,255,0.15)] bg-bg-dark text-text-muted transition-colors hover:border-purple-400/40 hover:text-purple-300"
                      title={t('videoGen.addReference', '添加参考图')}
                    >
                      <ImagePlus className="h-5 w-5" />
                    </button>
                    {addMenuOpen && (
                      <div className="absolute left-0 top-full z-50 mt-1.5 min-w-[180px] rounded-xl border border-[rgba(255,255,255,0.14)] bg-surface-dark p-1.5 shadow-xl">
                        <button
                          type="button"
                          onClick={handleOpenAssetPicker}
                          className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-text-dark transition-colors hover:bg-bg-dark"
                        >
                          <FolderOpen className="h-4 w-4 text-purple-400" />
                          {t('videoGen.importFromAssets', '从资产导入')}
                        </button>
                        <button
                          type="button"
                          onClick={handleLocalUpload}
                          className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-text-dark transition-colors hover:bg-bg-dark"
                        >
                          <Upload className="h-4 w-4 text-purple-400" />
                          {t('videoGen.uploadLocal', '本地上传')}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* 音色参考上传（Wan2.7 支持配音） */}
              <div className="mt-4">
                <label className="mb-1.5 block text-xs font-medium text-text-muted">
                  {t('videoGen.voiceRef', '音质参考（可选）')}
                </label>
                {referenceVoice ? (
                  <div className="flex items-center gap-2 rounded-lg border border-[rgba(255,255,255,0.1)] bg-bg-dark px-3 py-2">
                    <span className="flex-1 truncate text-xs text-text-dark">{referenceVoice.fileName}</span>
                    <button type="button" onClick={() => setReferenceVoice(null)} className="text-text-muted hover:text-red-400">
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      const input = document.createElement('input');
                      input.type = 'file';
                      input.accept = 'audio/*';
                      input.onchange = async (e) => {
                        const file = (e.target as HTMLInputElement).files?.[0];
                        if (!file) return;
                        const reader = new FileReader();
                        reader.onload = () => {
                          setReferenceVoice({
                            id: `voice-${Date.now()}`,
                            rawUrl: reader.result as string,
                            url: reader.result as string,
                            fileName: file.name,
                          });
                        };
                        reader.readAsDataURL(file);
                      };
                      input.click();
                    }}
                    className="flex h-9 items-center gap-1.5 rounded-lg border border-dashed border-[rgba(255,255,255,0.15)] bg-bg-dark px-3 text-xs text-text-muted transition-colors hover:border-purple-400/40 hover:text-purple-300"
                  >
                    <Upload className="h-4 w-4" />
                    {t('videoGen.uploadVoice', '上传音质参考')}
                  </button>
                )}
              </div>
            </div>

          </div>
        </div>

        {/* Right panel: preview */}
        <div className="flex flex-1 flex-col items-center justify-center p-6">
          {isLocalEnhancing && videoUrl ? (
            /* 本地4K超分 — 视频上叠加进度蒙版 */
            <div className="relative">
              <video
                src={displayVideoUrl ?? undefined}
                controls
                className="max-h-[600px] max-w-full rounded-xl"
                autoPlay
                loop
              />
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center rounded-xl bg-bg-dark/65">
                <div className="w-56 space-y-3">
                  <p className="text-center text-sm font-medium text-white">正在本地生成4K视频...</p>
                  <div className="h-2.5 w-full overflow-hidden rounded-full bg-white/15">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400 transition-all duration-700 ease-out"
                      style={{ width: `${localEnhanceProgress}%` }}
                    />
                  </div>
                  <p className="text-center text-xs text-white/70">
                    {localEnhanceProgress < 100
                      ? `${Math.round(localEnhanceProgress)}% — 预计需要 2–5 分钟`
                      : '处理完成'}
                  </p>
                </div>
              </div>
            </div>
          ) : !isUpscaling && videoUrl ? (
            <>
              <video
                src={displayVideoUrl ?? undefined}
                controls
                className="max-h-[600px] max-w-full rounded-xl"
                autoPlay
                loop
              />
            </>
          ) : isGenerating || isUpscaling ? (
            <div className="flex flex-col items-center gap-6">
              <div className="relative">
                <div className="absolute inset-0 animate-ping rounded-full border-2 border-purple-400/30" />
                <div className="absolute inset-0 animate-pulse rounded-full border-2 border-purple-400/20" />
                <LoaderCircle className="relative h-14 w-14 animate-spin text-purple-400" />
              </div>
              <div className="flex flex-col items-center gap-2">
                <p className="text-sm font-medium text-text-dark">
                  {isUpscaling
                    ? `正在生成${upscaleTarget}视频 (-${upscaleTarget === '2K' ? '20' : '35'}积分)...`
                    : isResuming
                      ? t('videoGen.resuming', '正在恢复之前的视频生成任务...')
                      : t('videoGen.generating', '正在生成视频...')}
                </p>
                <span className="inline-flex items-center gap-1 text-xs text-text-muted">
                  {isUpscaling ? '预计需要 1–3 分钟' : isResuming ? '小鸭正在处理中，请耐心等待...' : '预计需要 30–60 秒'}
                  <span className="inline-flex items-center">
                    <span className="mx-0.5 h-1 w-1 animate-bounce rounded-full bg-purple-400" style={{ animationDelay: '0ms' }} />
                    <span className="mx-0.5 h-1 w-1 animate-bounce rounded-full bg-purple-400" style={{ animationDelay: '150ms' }} />
                    <span className="mx-0.5 h-1 w-1 animate-bounce rounded-full bg-purple-400" style={{ animationDelay: '300ms' }} />
                  </span>
                </span>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-4 text-text-muted">
              <Film className="h-16 w-16 opacity-20" />
              <p className="text-sm">
                {t('videoGen.previewPlaceholder', '生成后将在此处预览视频')}
              </p>
            </div>
          )}

          {/* Credit display + actions */}
          <div className="mt-6 flex w-full max-w-md items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-text-muted">
              <Sparkles className="h-4 w-4 text-amber-400" />
              <span>
                {t('videoGen.creditCost', '本次消耗: {{cost}} 积分', { cost: creditCost })}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {/* History button */}
              <div ref={historyRef} className="relative">
                <button
                  type="button"
                  onClick={() => setShowHistory((v) => !v)}
                  disabled={combinedHistory.length === 0}
                  className="flex h-9 items-center gap-1.5 rounded-lg border border-[rgba(255,255,255,0.12)] bg-bg-dark px-2.5 text-xs text-text-muted transition-colors hover:bg-bg-dark/70 hover:text-text-dark disabled:opacity-30"
                  title={t('videoGen.history', '历史记录')}
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  {combinedHistory.length > 0 && (
                    <span className="text-[10px]">{combinedHistory.length}</span>
                  )}
                </button>
                {showHistory && combinedHistory.length > 0 && (
                  <div className="absolute bottom-full right-0 z-50 mb-2 w-[360px] max-h-[320px] overflow-hidden rounded-xl border border-[rgba(255,255,255,0.14)] bg-surface-dark shadow-2xl">
                    <div className="flex items-center justify-between border-b border-[rgba(255,255,255,0.08)] px-4 py-2.5">
                      <span className="text-xs font-semibold text-text-dark">
                        {t('videoGen.history', '历史记录')}
                      </span>
                      <span className="text-[10px] text-text-muted">
                        {combinedHistory.length} {t('videoGen.historyCount', '条记录')}
                      </span>
                    </div>
                    <div className="ui-scrollbar max-h-[260px] overflow-y-auto">
                      {combinedHistory.map((entry) => (
                        <button
                          key={entry.id}
                          type="button"
                          onClick={() => {
                            if (entry._generating) {
                              // 正在生成的任务：关闭历史，回到生成中视图即可
                              setVideoUrl(null);
                              setShowHistory(false);
                              return;
                            }
                            setVideoUrl(entry.videoUrl ?? null);
                            setPrompt(entry.prompt);
                            setAspectRatio(entry.aspectRatio);
                            setDuration(entry.duration);
                            setShowHistory(false);
                          }}
                          className="w-full border-b border-[rgba(255,255,255,0.04)] px-4 py-3 text-left transition-colors hover:bg-bg-dark last:border-b-0"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <p className="text-xs text-text-dark truncate">
                                {entry.prompt.startsWith('【2K视频】') ? (
                                  <span className="text-purple-300 font-medium">2K视频 </span>
                                ) : entry.prompt.startsWith('【4K视频】') ? (
                                  <span className="text-amber-300 font-medium">4K视频 </span>
                                ) : null}
                                {entry.prompt.replace(/^【[24]K视频】/, '').slice(0, 60)}
                                {entry.prompt.length > 60 ? '...' : ''}
                              </p>
                              <div className="mt-1 flex items-center gap-2 text-[10px] text-text-muted">
                                <span>{entry.aspectRatio}</span>
                                <span>{entry.duration}s</span>
                                {entry._generating ? (
                                  <span className="text-amber-400 font-medium">{t('videoGen.generatingLabel', '正在生成')}</span>
                                ) : (
                                  <span>{new Date(entry.createdAt).toLocaleString()}</span>
                                )}
                              </div>
                            </div>
                            {entry._generating ? (
                              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-amber-500/15">
                                <svg className="h-4 w-4 animate-spin text-amber-400" fill="none" viewBox="0 0 24 24">
                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                </svg>
                              </div>
                            ) : entry.videoUrl ? (
                              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-purple-500/15">
                                <svg className="h-4 w-4 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                              </div>
                            ) : null}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              {videoUrl && (
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const { invoke } = await import('@tauri-apps/api/core');
                      const { save } = await import('@tauri-apps/plugin-dialog');
                      let filename = videoUrl.split(/[/\\]/).pop() || 'video.mp4';
                      // 清理URL参数和编码字符
                      filename = filename.split('?')[0].split('#')[0];
                      filename = decodeURIComponent(filename);
                      if (filename.length > 50) filename = `video_${Date.now()}.mp4`;
                      const dest = await save({ defaultPath: filename, filters: [{ name: '视频', extensions: ['mp4'] }] });
                      if (dest) await invoke('copy_file_to_path', { src: videoUrl, dest });
                    } catch (e) { console.error('[VideoGenDialog] save failed:', e); }
                  }}
                  className="flex h-9 items-center gap-1.5 rounded-lg border border-[rgba(255,255,255,0.12)] bg-bg-dark px-3 text-xs text-text-dark transition-colors hover:bg-bg-dark/70"
                >
                  <Download className="h-3.5 w-3.5" />
                  {t('videoGen.download', '下载')}
                </button>
              )}
              <button
                type="button"
                onClick={handleGenerate}
                disabled={isGenerating}
                className="flex h-9 items-center gap-1.5 rounded-lg bg-purple-500/80 px-4 text-xs font-medium text-white transition-colors hover:bg-purple-500 disabled:opacity-40"
              >
                <Sparkles className="h-3.5 w-3.5" />
                {isResuming
                  ? t('videoGen.resuming', '正在恢复...')
                  : t('videoGen.generate', '生成视频')}
              </button>
            </div>
          </div>

          {/* 超分按钮 — 云端 + 本地 */}
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                if (!videoUrl) { setError('请先生成视频，再生成高分辨率版本'); return; }
                setUpscaleTarget('2K'); setShowUpscaleConfirm(true);
              }}
              disabled={isGenerating || isUpscaling || isLocalEnhancing}
              className="flex h-8 items-center gap-1.5 rounded-lg border border-purple-400/30 bg-purple-500/10 px-3 text-xs font-medium text-purple-300 transition-colors hover:bg-purple-500/20 disabled:opacity-40"
            >
              <Sparkles className="h-3.5 w-3.5" />
              云端 2K (-20积分)
            </button>
            <button
              type="button"
              onClick={() => {
                if (!videoUrl) { setError('请先生成视频，再生成高分辨率版本'); return; }
                setUpscaleTarget('4K'); setShowUpscaleConfirm(true);
              }}
              disabled={isGenerating || isUpscaling || isLocalEnhancing}
              className="flex h-8 items-center gap-1.5 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 text-xs font-medium text-amber-300 transition-colors hover:bg-amber-500/20 disabled:opacity-40"
            >
              <Sparkles className="h-3.5 w-3.5" />
              云端 4K (-35积分)
            </button>
            <button
              type="button"
              onClick={() => {
                if (!videoUrl) { setError('请先生成视频'); return; }
                if (enhanceSuppressVideoConfirmRef.current) {
                  void handleLocalEnhance();
                } else {
                  setShowLocalEnhanceConfirm(true);
                }
              }}
              disabled={isGenerating || isUpscaling || isLocalEnhancing}
              className="flex h-8 items-center gap-1.5 rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-3 text-xs font-medium text-emerald-300 transition-colors hover:bg-emerald-500/20 disabled:opacity-40"
            >
              <Sparkles className="h-3.5 w-3.5" />
              {isLocalEnhancing ? '本地生成4K中...' : '本地 4K (免费)'}
            </button>
          </div>

          {error && (() => {
            const wanErr = translateWanError(error);
            return (
              <div className="mt-3 max-w-md rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-left">
                <p className="text-sm font-semibold text-red-400">{wanErr.title}</p>
                <p className="mt-1 text-xs leading-relaxed text-red-300/80 whitespace-pre-wrap">{wanErr.detail}</p>
              </div>
            );
          })()}

        </div>
      </div>

      {/* Confirm dialog */}
      <UiModal
        isOpen={showConfirmDialog}
        onClose={() => setShowConfirmDialog(false)}
        title={t('videoGen.confirmGenerateTitle', '确认生成')}
        widthClassName="w-[420px]"
        footer={
          <div className="flex items-center gap-2 w-full">
            <UiChipButton
              className="h-8 px-3 text-xs"
              onClick={() => setShowConfirmDialog(false)}
            >
              {t('common.cancel', '取消')}
            </UiChipButton>
            <UiChipButton
              className="h-8 px-3 text-xs border-purple-400/60 bg-purple-500/20 text-purple-200"
              onClick={executeGenerate}
            >
              {t('videoGen.confirmGenerate', '确认生成')}
            </UiChipButton>
          </div>
        }
      >
        <div className="py-2 text-center">
          <p className="text-sm text-text-dark leading-relaxed">
            {t('videoGen.confirmGenerateMessage', '将消耗 {{cost}} 积分生成 {{duration}}秒 视频，确定生成吗？', {
              cost: creditCost,
              duration,
            })}
          </p>
          <p className="text-xs text-text-muted mt-2 leading-relaxed">
            {t('videoGen.promptOptimizationNotice', '为了准确性，系统可能会根据您的提示词做再次优化，可能会导致1-2积分的额外扣减')}
          </p>
        </div>
      </UiModal>

      {/* Insufficient credits dialog */}
      <UiModal
        isOpen={showInsufficientDialog && !showRecharge}
        onClose={() => setShowInsufficientDialog(false)}
        title={t('videoGen.insufficientCreditsTitle', '积分不足')}
        widthClassName="w-[420px]"
        footer={
          <div className="flex items-center gap-2 w-full">
            <UiChipButton
              className="h-8 px-3 text-xs"
              onClick={() => setShowInsufficientDialog(false)}
            >
              {t('common.cancel', '取消')}
            </UiChipButton>
            <UiChipButton
              className="h-8 px-3 text-xs border-amber-400/60 bg-amber-500/20 text-amber-200"
              onClick={() => setShowRecharge(true)}
            >
              {t('videoGen.goRecharge', '去充值')}
            </UiChipButton>
          </div>
        }
      >
        <div className="py-2 text-center">
          <p className="text-sm text-text-dark leading-relaxed">
            {t('videoGen.insufficientCreditsMessage', '本次生成需要 {{required}} 积分，当前剩余 {{current}} 积分，请充值后再试。', {
              required: insufficientRequired,
              current: insufficientCurrent,
            })}
          </p>
        </div>
      </UiModal>

      {showRecharge && (
        <RechargeDialog
          isOpen={showRecharge}
          onClose={() => setShowRecharge(false)}
          onPaid={async () => {
            setShowRecharge(false);
            setShowInsufficientDialog(false);
            setError(null);
          }}
        />
      )}

      {/* Storyboard prompt picker */}
      <StoryboardPromptPicker
        isOpen={showPromptPicker}
        onClose={() => setShowPromptPicker(false)}
        onSelect={handleSelectPrompt}
      />

      {/* Asset picker dialog */}
      {showAssetPicker && (
        <div className="fixed inset-0 z-[160] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="flex h-[500px] w-[520px] max-w-[90vw] flex-col overflow-hidden rounded-2xl border border-[rgba(255,255,255,0.12)] bg-surface-dark shadow-2xl">
            <div className="flex items-center justify-between border-b border-[rgba(255,255,255,0.08)] px-5 py-3.5">
              <h3 className="text-sm font-semibold text-text-dark">
                {t('videoGen.selectAssets', '选择资产')}
              </h3>
              <button
                type="button"
                onClick={() => setShowAssetPicker(false)}
                className="rounded-lg p-1.5 text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {assets.length === 0 ? (
              <div className="flex flex-1 items-center justify-center text-sm text-text-muted">
                {t('videoGen.noAssets', '暂无资产，请先在项目管理中添加资产')}
              </div>
            ) : (
              <div className="ui-scrollbar flex-1 overflow-y-auto p-3">
                <div className="grid grid-cols-3 gap-2">
                  {assets.map((asset: any) => {
                    const isSelected = assetPickerSelected.has(asset.id);
                    return (
                      <button
                        key={asset.id}
                        type="button"
                        onClick={() => toggleAssetSelection(asset.id)}
                        className={`relative flex flex-col items-center rounded-xl border p-2 transition-colors ${
                          isSelected
                            ? 'border-purple-400/60 bg-purple-500/20'
                            : 'border-[rgba(255,255,255,0.08)] bg-bg-dark hover:border-purple-400/30'
                        }`}
                      >
                        <img
                          src={convertFileSrc(asset.filePath)}
                          alt={asset.name}
                          className="h-20 w-full rounded-lg object-cover"
                        />
                        <span className="mt-1.5 text-center text-xs font-medium text-text-dark truncate w-full">
                          {asset.name}
                        </span>
                        <span className="text-[10px] text-text-muted">
                          {String(t(`asset.category.${asset.category}`, asset.category))}
                        </span>
                        {isSelected && (
                          <div className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-purple-500 text-white">
                            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="flex items-center justify-between border-t border-[rgba(255,255,255,0.08)] px-5 py-3">
              <span className="text-xs text-text-muted">
                {assetPickerSelected.size > 0
                  ? t('videoGen.assetCount', '已选 {{count}} 项', { count: assetPickerSelected.size })
                  : t('videoGen.clickToSelect', '点击选择资产')}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowAssetPicker(false)}
                  className="h-8 rounded-lg border border-[rgba(255,255,255,0.1)] bg-bg-dark px-3 text-xs text-text-muted transition-colors hover:text-text-dark"
                >
                  {t('common.cancel', '取消')}
                </button>
                <button
                  type="button"
                  onClick={handleConfirmAssetImport}
                  disabled={assetPickerSelected.size === 0}
                  className="h-8 rounded-lg bg-purple-500/80 px-4 text-xs font-medium text-white transition-colors hover:bg-purple-500 disabled:opacity-30"
                >
                  {t('common.confirm', '确认')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Upscale confirmation modal */}
      <UiModal
        isOpen={showUpscaleConfirm}
        title={`生成${upscaleTarget}视频`}
        onClose={() => setShowUpscaleConfirm(false)}
        widthClassName="w-[400px]"
        footer={
          <div className="flex gap-2 w-full">
            <UiButton variant="muted" size="sm" onClick={() => setShowUpscaleConfirm(false)} className="flex-1">
              {t('common.cancel', '取消')}
            </UiButton>
            <UiButton variant="primary" size="sm" onClick={async () => {
              setShowUpscaleConfirm(false);
              if (!upscaleTarget || !videoUrl) return;
              setIsUpscaling(true);
              setError(null);
              try {
                const { baiduUpscaleVideo } = await import('@/commands/ai');
                const result = await baiduUpscaleVideo(videoUrl, upscaleTarget);
                setVideoUrl(result);
                // Add to history with 2K/4K label
                if (nodeIdRef.current) {
                  const label = upscaleTarget === '2K' ? '【2K视频】' : '【4K视频】';
                  addToHistory(nodeIdRef.current, {
                    prompt: label + (prompt?.trim() || ''),
                    aspectRatio,
                    duration,
                    videoModel,
                    videoUrl: result,
                    referenceImageUrls: referenceImages.map(({ id, rawUrl, url }) => ({ id, rawUrl, url })),
                    referenceVoice: referenceVoice ?? undefined,
                    gridFrames: gridFrames.length > 0 ? gridFrames : undefined,
                  });
                }
              } catch (e: any) {
                setError(e?.message || String(e));
              } finally {
                setIsUpscaling(false);
              }
            }} className="flex-1">
              {t('common.confirm', '确认')}
            </UiButton>
          </div>
        }
      >
        <div className="text-center py-4">
          <p className="text-sm text-text-dark">
            将当前视频超分为{upscaleTarget}分辨率，消耗{upscaleTarget === '2K' ? '20' : '35'}积分，处理需要 1-3 分钟。
          </p>
        </div>
      </UiModal>

      {/* 本地超分硬件要求确认弹窗 */}
      <UiModal
        isOpen={showLocalEnhanceConfirm}
        title="本地视频超分"
        onClose={() => setShowLocalEnhanceConfirm(false)}
        widthClassName="w-[420px]"
        footer={
          <div className="flex gap-2 w-full">
            <UiButton variant="muted" size="sm" onClick={() => setShowLocalEnhanceConfirm(false)} className="flex-1">
              取消
            </UiButton>
            <UiButton variant="primary" size="sm" onClick={() => {
              setShowLocalEnhanceConfirm(false);
              void handleLocalEnhance();
            }} className="flex-1 !bg-emerald-600 hover:!bg-emerald-500">
              继续
            </UiButton>
          </div>
        }
      >
        <div className="space-y-3 py-2 text-sm text-text-muted">
          <p className="font-medium text-text-dark">此功能使用本地 GPU 进行 AI 视频超分增强</p>
          <div className="rounded-lg border border-[rgba(255,255,255,0.08)] bg-bg-dark p-3">
            <p className="font-medium text-text-dark mb-2">最低硬件要求：</p>
            <ul className="list-disc space-y-1 pl-4 text-xs">
              <li>支持 Vulkan 1.1+ 的显卡</li>
              <li>NVIDIA GTX 1060 / AMD RX 580 / Intel Arc 及以上</li>
              <li>至少 2GB 显存（4GB 推荐）</li>
            </ul>
          </div>
          <p className="text-xs leading-relaxed">
            处理时间取决于视频时长和 GPU 性能，通常需要 2-5 分钟。
            处理期间请勿关闭窗口。
          </p>
          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 rounded accent-emerald-500"
              defaultChecked={enhanceSuppressVideoConfirmRef.current}
              onChange={(e) => {
                enhanceSuppressVideoConfirmRef.current = e.currentTarget.checked;
                if (e.currentTarget.checked) {
                  localStorage.setItem('enhance:suppressVideoConfirm', '1');
                } else {
                  localStorage.removeItem('enhance:suppressVideoConfirm');
                }
              }}
            />
            <span>以后不再提示</span>
          </label>
        </div>
      </UiModal>
    </div>
  );
}
