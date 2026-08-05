import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { UI_CONTENT_OVERLAY_INSET_CLASS, UI_DIALOG_TRANSITION_MS } from '@/components/ui/motion';
import { useDialogTransition } from '@/components/ui/useDialogTransition';
import { analyzeStory, type StoryAnalysisResult } from '@/commands/chat';
import { generateProjectGlobalsMd } from '@/commands/projectState';
import { useProjectStore } from '@/stores/projectStore';
import { useChatStore } from '@/stores/chatStore';
import { listAssets } from '@/commands/asset';
import { readProjectGlobalsMd } from '@/commands/projectState';
import { PresetPicker } from './PresetPicker';
import {
  ASPECT_RATIO_OPTIONS,
  STYLE_PRESETS,
  TONE_PRESETS,
  SHORTVIDEO_STYLE_PRESETS,
  EMPHASIS_DIMENSIONS,
  getEmphasisLabels,
  getVideoTypeLabel,
} from './presets';

interface ReanalyzeDialogProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
}

interface AnalysisState {
  phase: 'input' | 'analyzing' | 'report' | 'error';
  report: StoryAnalysisResult | null;
  error: string | null;
}

const inputClass =
  'w-full px-3 py-2 bg-bg-dark border border-border-dark rounded text-text-dark placeholder-text-muted focus:outline-none focus:border-primary text-sm';

const labelClass = 'block text-sm font-medium text-text-dark mb-1.5';
const STORYBOARD_MAX_CHARS = 5000;

export function ReanalyzeDialog({ isOpen, onClose, projectId }: ReanalyzeDialogProps) {
  const { t: _ } = useTranslation();
  const { shouldRender, isVisible } = useDialogTransition(isOpen, UI_DIALOG_TRANSITION_MS);

  const [storyOutline, setStoryOutline] = useState('');
  const [aspectRatio, setAspectRatio] = useState('');
  const [style, setStyle] = useState('');
  const [tone, setTone] = useState('');
  const [directorRef, setDirectorRef] = useState('');
  const [emphasisKeys, setEmphasisKeys] = useState<string[]>([]);
  const [analysis, setAnalysis] = useState<AnalysisState>({ phase: 'input', report: null, error: null });

  // Pre-fill from current project when opening
  useEffect(() => {
    if (!isOpen || !projectId) return;
    const project = useProjectStore.getState().currentProject;
    if (!project) return;
    setAspectRatio(project.aspectRatio ?? '');
    setStyle(project.style ?? '');
    setTone(project.tone ?? '');
    setDirectorRef(project.directorRef ?? '');
    setEmphasisKeys(project.emphasisDimensions.filter((d) => d.enabled).map((d) => d.key));
    setStoryOutline('');
    setAnalysis({ phase: 'input', report: null, error: null });
  }, [isOpen, projectId]);

  const handleToggleEmphasis = (key: string) => {
    setEmphasisKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  };

  const handleAnalyze = async () => {
    const story = storyOutline.trim();
    if (!story) return;

    setAnalysis({ phase: 'analyzing', report: null, error: null });

    try {
      const result = await analyzeStory({
        storyOutline: story,
        aspectRatio,
        style,
        tone,
        directorRef,
        emphasisDimensions: getEmphasisLabels(emphasisKeys),
      });

      setAnalysis({ phase: 'report', report: result, error: null });
    } catch (err) {
      setAnalysis({
        phase: 'error',
        report: null,
        error: err instanceof Error ? err.message : '分析失败，请重试',
      });
    }
  };

  const handleConfirmReport = async () => {
    const report = analysis.report;
    if (!report) return;

    const project = useProjectStore.getState().currentProject;
    const projectName = project?.name ?? '';

    // Update project params
    useProjectStore.getState().updateProjectParams(projectId, {
      aspectRatio,
      style,
      tone,
      directorRef,
      emphasisKeys,
    });

    // Save analysis
    useProjectStore.getState().saveProjectAnalysis(projectId, {
      aiAnalysis: report.analysis_summary,
      aiParams: report.raw_json,
    });

    // Re-generate project_globals.md
    const mdPath = await generateProjectGlobalsMd({
      projectId,
      projectName,
      videoType: useProjectStore.getState().currentProject?.videoType ?? '',
      aspectRatio,
      style,
      tone,
      directorRef,
      emphasisDimensions: getEmphasisLabels(emphasisKeys),
      analysisSummary: report.analysis_summary,
      aiParamsJson: report.raw_json,
    }).catch(() => '');

    if (mdPath) {
      useProjectStore.getState().saveProjectAnalysis(projectId, {
        globalParamsMdPath: mdPath,
      });
    }

    // Refresh chat context with new globals + assets
    let context = await readProjectGlobalsMd(projectId).catch(() => '');

    // Fallback: build minimal context from project params when no MD
    if (!context.trim()) {
      const current = useProjectStore.getState().currentProject;
      if (current) {
        const parts: string[] = [];
        parts.push(`# ${current.name}\n`);
        parts.push('## 项目全局参数\n');
        if (current.videoType) parts.push(`- 视频类型: ${getVideoTypeLabel(current.videoType)}`);
        if (current.aspectRatio) parts.push(`- 画幅比例: ${current.aspectRatio}`);
        if (current.style) parts.push(`- 视觉风格: ${current.style}`);
        if (current.tone) parts.push(`- 项目调性: ${current.tone}`);
        if (current.directorRef) parts.push(`- 旅行视频风格: ${current.directorRef}`);
        const emphasisLabels = getEmphasisLabels(current.emphasisDimensions.filter((d) => d.enabled).map((d) => d.key));
        if (emphasisLabels.length > 0) {
          parts.push(`- 提示词重点维度: ${emphasisLabels.join('、')}`);
        }
        context = parts.join('\n') + '\n';
      }
    }

    try {
      const assets = await listAssets(projectId);
      if (assets.length > 0) {
        const catLabel = (cat: string) =>
          cat === 'character' ? '角色' : cat === 'scene' ? '场景' : '服饰道具';
        const lines = assets.map((a, i) =>
          `@图${i + 1}: ${a.name} (${catLabel(a.category)})`,
        );
        context = `${context}\n## 可用参考图\n${lines.join('\n')}\n\n生成分镜提示词时，如需引用参考图请使用 @图N 格式。`;
      }
    } catch { /* ok */ }
    useChatStore.getState().setProjectContext(context);

    onClose();
  };

  const handleRetry = () => {
    setAnalysis({ phase: 'input', report: null, error: null });
  };

  if (!shouldRender) return null;

  return (
    <div className={`fixed ${UI_CONTENT_OVERLAY_INSET_CLASS} z-[101] flex items-center justify-center`}>
      <div
        className={`absolute inset-0 bg-black/50 transition-opacity duration-200 ${isVisible ? 'opacity-100' : 'opacity-0'}`}
        onClick={onClose}
      />

      <div
        className={`relative w-[600px] max-h-[85vh] overflow-y-auto rounded-xl border border-border-dark bg-surface-dark p-6 shadow-xl transition-opacity duration-200 ${
          isVisible ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {/* Input phase */}
        {analysis.phase === 'input' && (
          <>
            <h2 className="text-lg font-semibold text-text-dark mb-2">重新分析</h2>
            <p className="text-xs text-text-muted mb-4">
              输入故事大纲（支持修改或补充），小鸭将重新分析项目。项目参数沿用当前设置，可按需调整。
            </p>

            {/* Story outline */}
            <div className="mb-4">
              <label className={labelClass}>故事大纲 *</label>
              <textarea
                value={storyOutline}
                onChange={(e) => setStoryOutline(e.target.value.slice(0, STORYBOARD_MAX_CHARS))}
                placeholder="请输入或修改故事大纲..."
                className={`${inputClass} resize-y`}
                style={{ height: '28vh', minHeight: '180px' }}
                autoFocus
              />
              <div className="text-xs text-text-muted mt-1 text-right">{storyOutline.length} / {STORYBOARD_MAX_CHARS} 字</div>
            </div>

            {/* Parameters */}
            <div className="space-y-4 mb-5">
              <div>
                <label className={labelClass}>画幅比例</label>
                <div className="flex flex-wrap gap-2">
                  {ASPECT_RATIO_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setAspectRatio(opt.value)}
                      className={`px-3 py-1.5 text-sm rounded border transition-colors ${
                        aspectRatio === opt.value
                          ? 'border-accent bg-accent/10 text-accent'
                          : 'border-border-dark text-text-muted hover:border-text-muted'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className={labelClass}>视觉风格</label>
                <PresetPicker presets={STYLE_PRESETS} value={style} onChange={setStyle} placeholder="输入自定义风格..." />
              </div>

              <div>
                <label className={labelClass}>项目调性</label>
                <PresetPicker presets={TONE_PRESETS} value={tone} onChange={setTone} placeholder="输入自定义调性..." />
              </div>

              <div>
                <label className={labelClass}>旅行视频风格</label>
                <PresetPicker presets={SHORTVIDEO_STYLE_PRESETS} value={directorRef} onChange={setDirectorRef} placeholder="输入自定义风格..." />
              </div>

              <div>
                <label className={`${labelClass} mb-2`}>提示词重点维度</label>
                <div className="space-y-1.5 max-h-[25vh] overflow-y-auto">
                  {EMPHASIS_DIMENSIONS.map((dim) => (
                    <label key={dim.key} className="flex items-start gap-2.5 p-2 rounded hover:bg-bg-dark/50 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={emphasisKeys.includes(dim.key)}
                        onChange={() => handleToggleEmphasis(dim.key)}
                        className="mt-0.5 accent-accent"
                      />
                      <div>
                        <span className="text-sm text-text-dark">{dim.label}</span>
                        <p className="text-xs text-text-muted">{dim.desc}</p>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2 border-t border-border-dark">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm text-text-muted hover:text-text-dark transition-colors"
              >
                取消
              </button>
              <button
                type="button"
                disabled={!storyOutline.trim()}
                onClick={handleAnalyze}
                className={`px-5 py-2 text-sm rounded transition-colors ${
                  storyOutline.trim()
                    ? 'bg-accent text-white hover:bg-accent/85'
                    : 'bg-bg-dark text-text-muted cursor-not-allowed'
                }`}
              >
                开始分析
              </button>
            </div>
          </>
        )}

        {/* Analyzing phase */}
        {analysis.phase === 'analyzing' && (
          <div className="flex flex-col items-center justify-center py-12">
            <div className="w-10 h-10 border-2 border-accent/30 border-t-accent rounded-full animate-spin mb-4" />
            <p className="text-sm text-text-dark font-medium mb-1">小鸭正在分析故事...</p>
            <p className="text-xs text-text-muted">小鸭正在分析剧本结构、角色设定和视觉风格</p>
          </div>
        )}

        {/* Error phase */}
        {analysis.phase === 'error' && (
          <>
            <h2 className="text-lg font-semibold text-text-dark mb-3">分析失败</h2>
            <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-lg mb-4">
              <p className="text-sm text-red-400">{analysis.error}</p>
            </div>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm text-text-muted hover:text-text-dark transition-colors"
              >
                关闭
              </button>
              <button
                type="button"
                onClick={handleRetry}
                className="px-4 py-2 text-sm bg-accent text-white hover:bg-accent/85 rounded transition-colors"
              >
                返回修改
              </button>
            </div>
          </>
        )}

        {/* Report phase */}
        {analysis.phase === 'report' && analysis.report && (
          <>
            <h2 className="text-lg font-semibold text-text-dark mb-3">分析报告</h2>

            <div className="space-y-3 max-h-[50vh] overflow-y-auto mb-4">
              {analysis.report.genre && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-text-muted shrink-0">类型：</span>
                  <span className="text-sm text-text-dark">{analysis.report.genre}</span>
                </div>
              )}
              {analysis.report.logline && (
                <div>
                  <span className="text-xs text-text-muted">一句话梗概：</span>
                  <p className="text-sm text-text-dark mt-0.5">{analysis.report.logline}</p>
                </div>
              )}
              {analysis.report.themes && analysis.report.themes.length > 0 && (
                <div>
                  <span className="text-xs text-text-muted">主题：</span>
                  <div className="flex flex-wrap gap-1 mt-0.5">
                    {analysis.report.themes.map((t: string, i: number) => (
                      <span key={i} className="px-2 py-0.5 text-xs rounded bg-accent/10 text-accent">{t}</span>
                    ))}
                  </div>
                </div>
              )}
              {analysis.report.characters && analysis.report.characters.length > 0 && (
                <div>
                  <span className="text-xs text-text-muted">角色：</span>
                  <div className="space-y-1.5 mt-0.5">
                    {analysis.report.characters.map((c: { name: string; archetype?: string; arc?: string }, i: number) => (
                      <div key={i} className="text-sm text-text-dark">
                        <span className="font-medium">{c.name}</span>
                        {c.archetype && <span className="text-text-muted text-xs ml-1">({c.archetype})</span>}
                        {c.arc && <span className="text-text-muted text-xs ml-1">— {c.arc}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {analysis.report.visual_style && (
                <div>
                  <span className="text-xs text-text-muted">视觉风格：</span>
                  <div className="text-sm text-text-dark mt-0.5">
                    {analysis.report.visual_style.color_palette && (
                      <p>配色：{analysis.report.visual_style.color_palette}</p>
                    )}
                    {analysis.report.visual_style.lighting && (
                      <p>光影：{analysis.report.visual_style.lighting}</p>
                    )}
                    {analysis.report.visual_style.camera && (
                      <p>摄影：{analysis.report.visual_style.camera}</p>
                    )}
                  </div>
                </div>
              )}
              {analysis.report.pacing && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-text-muted">节奏：</span>
                  <span className="text-sm text-text-dark">{analysis.report.pacing}</span>
                </div>
              )}
              {analysis.report.analysis_summary && (
                <div>
                  <span className="text-xs text-text-muted">分析摘要：</span>
                  <p className="text-sm text-text-dark mt-0.5">{analysis.report.analysis_summary}</p>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-3 pt-2 border-t border-border-dark">
              <button
                type="button"
                onClick={handleRetry}
                className="px-4 py-2 text-sm text-text-muted hover:text-text-dark transition-colors"
              >
                返回修改
              </button>
              <button
                type="button"
                onClick={handleConfirmReport}
                className="px-5 py-2 text-sm bg-accent text-white hover:bg-accent/85 rounded transition-colors"
              >
                确认并保存
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
