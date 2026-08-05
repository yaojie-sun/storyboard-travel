import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UI_CONTENT_OVERLAY_INSET_CLASS, UI_DIALOG_TRANSITION_MS } from '@/components/ui/motion';
import { useDialogTransition } from '@/components/ui/useDialogTransition';
import { PresetPicker } from './PresetPicker';
import {
  ASPECT_RATIO_OPTIONS,
  STYLE_PRESETS,
  TONE_PRESETS,
  SHORTVIDEO_STYLE_PRESETS,
  TRAVEL_VIDEO_TYPES,
  EMPHASIS_DIMENSIONS,
} from './presets';

interface ProjectSetupDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (params: ProjectSetupParams) => void;
}

export interface ProjectSetupParams {
  storyOutline: string;
  videoType: string;
  aspectRatio: string;
  style: string;
  tone: string;
  directorRef: string;
  emphasisKeys: string[];
}

const STORYBOARD_MAX_CHARS = 5000;

type SetupStep = 'outline' | 'params' | 'emphasis';

const inputClass =
  'w-full px-3 py-2 bg-bg-dark border border-border-dark rounded text-text-dark placeholder-text-muted focus:outline-none focus:border-primary text-sm';

const labelClass = 'block text-sm font-medium text-text-dark mb-1.5';

export function ProjectSetupDialog({ isOpen, onClose, onConfirm }: ProjectSetupDialogProps) {
  const { t: _ } = useTranslation();
  const { shouldRender, isVisible } = useDialogTransition(isOpen, UI_DIALOG_TRANSITION_MS);

  const [step, setStep] = useState<SetupStep>('outline');
  const [storyOutline, setStoryOutline] = useState('');
  const [videoType, setVideoType] = useState('');
  const [aspectRatio, setAspectRatio] = useState('');
  const [style, setStyle] = useState('');
  const [tone, setTone] = useState('');
  const [directorRef, setDirectorRef] = useState('');
  const [emphasisKeys, setEmphasisKeys] = useState<string[]>([]);
  const [showWarning, setShowWarning] = useState(false);

  const handleToggleEmphasis = (key: string) => {
    setEmphasisKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  };

  const handleStep2Next = () => {
    if (emphasisKeys.length >= 2) {
      setShowWarning(true);
    } else {
      handleConfirm();
    }
  };

  const handleConfirmWithWarning = () => {
    setShowWarning(false);
    handleConfirm();
  };

  const handleConfirm = () => {
    onConfirm({
      storyOutline,
      videoType,
      aspectRatio,
      style,
      tone,
      directorRef,
      emphasisKeys,
    });
  };

  const canGoNext_story = storyOutline.trim().length > 0;

  if (!shouldRender) return null;

  return (
    <div className={`fixed ${UI_CONTENT_OVERLAY_INSET_CLASS} z-[100] flex items-center justify-center`}>
      {/* Backdrop */}
      <div
        className={`absolute inset-0 bg-black/50 transition-opacity duration-200 ${isVisible ? 'opacity-100' : 'opacity-0'}`}
        onClick={onClose}
      />

      {/* Dialog */}
      <div
        className={`relative w-[560px] max-h-[85vh] rounded-xl border border-border-dark bg-surface-dark p-6 shadow-xl transition-opacity duration-200 overflow-y-auto ${
          isVisible ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {/* Step indicator */}
        <div className="flex items-center gap-2 mb-6">
          {(['outline', 'params', 'emphasis'] as SetupStep[]).map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium ${
                  step === s
                    ? 'bg-accent text-white'
                    : ['outline', 'params'].indexOf(step) >= i
                      ? 'bg-accent/30 text-text-dark'
                      : 'bg-bg-dark text-text-muted'
                }`}
              >
                {i + 1}
              </div>
              <span
                className={`text-xs ${step === s ? 'text-text-dark font-medium' : 'text-text-muted'}`}
              >
                {s === 'outline' ? '故事大纲' : s === 'params' ? '项目参数' : '重点维度'}
              </span>
              {i < 2 && <span className="text-text-muted text-xs mx-1">→</span>}
            </div>
          ))}
        </div>

        {/* Step 1: Story Outline */}
        {step === 'outline' && (
          <div>
            <h2 className="text-lg font-semibold text-text-dark mb-2">故事大纲</h2>
            <p className="text-xs text-text-muted mb-4">
              请输入故事的大致情节、主要角色和世界观设定。小鸭将据此分析出项目的全局参数。
            </p>
            <textarea
              value={storyOutline}
              onChange={(e) => setStoryOutline(e.target.value.slice(0, STORYBOARD_MAX_CHARS))}
              placeholder="请输入故事大纲..."
              className={`${inputClass} resize-y`}
              style={{ height: '35vh', minHeight: '200px' }}
              autoFocus
            />
            <div className="flex justify-between items-center mt-2">
              <span className="text-xs text-text-muted">
                {storyOutline.length} / {STORYBOARD_MAX_CHARS} 字
              </span>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 text-sm text-text-muted hover:text-text-dark transition-colors"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={!canGoNext_story}
                  onClick={() => setStep('params')}
                  className={`px-4 py-2 text-sm rounded transition-colors ${
                    canGoNext_story
                      ? 'bg-accent text-white hover:bg-accent/85'
                      : 'bg-bg-dark text-text-muted cursor-not-allowed'
                  }`}
                >
                  下一步
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Step 2: Project Parameters */}
        {step === 'params' && (
          <div>
            <h2 className="text-lg font-semibold text-text-dark mb-2">项目基础参数</h2>
            <p className="text-xs text-text-muted mb-4">选填，可留空或选择预设。</p>

            <div className="space-y-4">
              {/* Video Type */}
              <div>
                <label className={labelClass}>视频类型</label>
                <div className="flex flex-wrap gap-2">
                  {TRAVEL_VIDEO_TYPES.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setVideoType(opt.value)}
                      className={`px-3 py-1.5 text-sm rounded border transition-colors ${
                        videoType === opt.value
                          ? 'border-accent bg-accent/10 text-accent'
                          : 'border-border-dark text-text-muted hover:border-text-muted'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Aspect Ratio */}
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

              {/* Style */}
              <div>
                <label className={labelClass}>视觉风格</label>
                <PresetPicker presets={STYLE_PRESETS} value={style} onChange={setStyle} placeholder="输入自定义风格..." />
              </div>

              {/* Tone */}
              <div>
                <label className={labelClass}>项目调性</label>
                <PresetPicker presets={TONE_PRESETS} value={tone} onChange={setTone} placeholder="输入自定义调性..." />
              </div>

              {/* Short Video Style */}
              <div>
                <label className={labelClass}>{_('projectSetup.shortVideoStyle')}</label>
                <PresetPicker presets={SHORTVIDEO_STYLE_PRESETS} value={directorRef} onChange={setDirectorRef} placeholder="输入自定义风格..." />
              </div>
            </div>

            <div className="flex justify-between items-center mt-6">
              <button
                type="button"
                onClick={() => setStep('outline')}
                className="px-4 py-2 text-sm text-text-muted hover:text-text-dark transition-colors"
              >
                上一步
              </button>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 text-sm text-text-muted hover:text-text-dark transition-colors"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => setStep('emphasis')}
                  className="px-4 py-2 text-sm bg-accent text-white hover:bg-accent/85 rounded transition-colors"
                >
                  下一步
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Step 3: Emphasis Dimensions */}
        {step === 'emphasis' && (
          <div>
            <h2 className="text-lg font-semibold text-text-dark mb-2">提示词重点维度</h2>
            <p className="text-xs text-text-muted mb-4">
              选择在生成分镜提示词时需要重点关注的方面。建议只选 1 个最核心的维度。
              <span className="block mt-1 text-amber-500">
                ⚠️ 选中 2 个及以上时需确认——参数越多，小鸭生成的视频越容易偏离预期。
              </span>
            </p>

            <div className="space-y-2 max-h-[40vh] overflow-y-auto">
              {EMPHASIS_DIMENSIONS.map((dim) => (
                <label
                  key={dim.key}
                  className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                    emphasisKeys.includes(dim.key)
                      ? 'border-accent bg-accent/5'
                      : 'border-border-dark hover:border-text-muted'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={emphasisKeys.includes(dim.key)}
                    onChange={() => handleToggleEmphasis(dim.key)}
                    className="mt-0.5 accent-accent"
                  />
                  <div>
                    <div className="text-sm font-medium text-text-dark">{dim.label}</div>
                    <div className="text-xs text-text-muted">{dim.desc}</div>
                  </div>
                </label>
              ))}
            </div>

            <div className="flex justify-between items-center mt-6">
              <button
                type="button"
                onClick={() => setStep('params')}
                className="px-4 py-2 text-sm text-text-muted hover:text-text-dark transition-colors"
              >
                上一步
              </button>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 text-sm text-text-muted hover:text-text-dark transition-colors"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleStep2Next}
                  className="px-4 py-2 text-sm bg-accent text-white hover:bg-accent/85 rounded transition-colors"
                >
                  确认并分析
                </button>
              </div>
            </div>

            {/* Warning overlay */}
            {showWarning && (
              <div className="absolute inset-0 bg-black/60 rounded-xl flex items-center justify-center z-10">
                <div className="bg-surface-dark border border-border-dark rounded-xl p-6 mx-6 max-w-sm">
                  <h3 className="text-base font-semibold text-text-dark mb-3">确认选择</h3>
                  <p className="text-sm text-text-muted mb-4">
                    你已选中 {emphasisKeys.length} 个重点维度。参数越多，小鸭生成视频时越容易偏离预期效果，建议只保留 1 个最核心的维度。
                  </p>
                  <p className="text-sm text-text-muted mb-5">确定要继续使用当前选择吗？</p>
                  <div className="flex justify-end gap-3">
                    <button
                      type="button"
                      onClick={() => setShowWarning(false)}
                      className="px-4 py-2 text-sm text-text-muted hover:text-text-dark transition-colors"
                    >
                      返回修改
                    </button>
                    <button
                      type="button"
                      onClick={handleConfirmWithWarning}
                      className="px-4 py-2 text-sm bg-accent text-white hover:bg-accent/85 rounded transition-colors"
                    >
                      确定继续
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
