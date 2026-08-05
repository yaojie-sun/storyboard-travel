import { useState, useEffect } from 'react';
import { UI_CONTENT_OVERLAY_INSET_CLASS, UI_DIALOG_TRANSITION_MS } from '@/components/ui/motion';
import { useDialogTransition } from '@/components/ui/useDialogTransition';
import type { EmphasisDimension } from '@/stores/projectStore';
import { PresetPicker } from './PresetPicker';
import {
  ASPECT_RATIO_OPTIONS,
  STYLE_PRESETS,
  TONE_PRESETS,
  SHORTVIDEO_STYLE_PRESETS,
  TRAVEL_VIDEO_TYPES,
  EMPHASIS_DIMENSIONS,
} from './presets';

interface EditParamsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (params: {
    videoType?: string;
    aspectRatio: string;
    style: string;
    tone: string;
    directorRef: string;
    emphasisKeys: string[];
  }) => void;
  initial: {
    videoType?: string;
    aspectRatio: string;
    style: string;
    tone: string;
    directorRef: string;
    emphasisDimensions: EmphasisDimension[];
  };
}

export function EditParamsDialog({ isOpen, onClose, onConfirm, initial }: EditParamsDialogProps) {
  const { shouldRender, isVisible } = useDialogTransition(isOpen, UI_DIALOG_TRANSITION_MS);

  const [videoType, setVideoType] = useState(initial.videoType ?? '');
  const [aspectRatio, setAspectRatio] = useState(initial.aspectRatio);
  const [style, setStyle] = useState(initial.style);
  const [tone, setTone] = useState(initial.tone);
  const [directorRef, setDirectorRef] = useState(initial.directorRef);
  const [emphasisKeys, setEmphasisKeys] = useState<string[]>(
    initial.emphasisDimensions.filter((d) => d.enabled).map((d) => d.key),
  );

  useEffect(() => {
    if (isOpen) {
      setVideoType(initial.videoType ?? '');
      setAspectRatio(initial.aspectRatio);
      setStyle(initial.style);
      setTone(initial.tone);
      setDirectorRef(initial.directorRef);
      setEmphasisKeys(initial.emphasisDimensions.filter((d) => d.enabled).map((d) => d.key));
    }
  }, [isOpen, initial]);

  const handleToggleEmphasis = (key: string) => {
    setEmphasisKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  };

  const handleConfirm = () => {
    onConfirm({ videoType, aspectRatio, style, tone, directorRef, emphasisKeys });
    onClose();
  };

  const labelClass = 'block text-sm font-medium text-text-dark mb-1.5';

  if (!shouldRender) return null;

  return (
    <div className={`fixed ${UI_CONTENT_OVERLAY_INSET_CLASS} z-[100] flex items-center justify-center`}>
      <div
        className={`absolute inset-0 bg-black/50 transition-opacity duration-200 ${isVisible ? 'opacity-100' : 'opacity-0'}`}
        onClick={onClose}
      />
      <div
        className={`relative w-[520px] max-h-[80vh] overflow-y-auto rounded-lg border border-border-dark bg-surface-dark p-6 shadow-xl transition-opacity duration-200 ${isVisible ? 'opacity-100' : 'opacity-0'}`}
      >
        <h2 className="text-lg font-semibold text-text-dark mb-4">编辑项目参数</h2>

        {/* Video Type */}
        <div className="mb-4">
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
        <div className="mb-4">
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
        <div className="mb-4">
          <label className={labelClass}>视觉风格</label>
          <PresetPicker presets={STYLE_PRESETS} value={style} onChange={setStyle} placeholder="输入自定义风格..." />
        </div>

        {/* Tone */}
        <div className="mb-4">
          <label className={labelClass}>项目调性</label>
          <PresetPicker presets={TONE_PRESETS} value={tone} onChange={setTone} placeholder="输入自定义调性..." />
        </div>

        {/* Short Video Style */}
        <div className="mb-4">
          <label className={labelClass}>旅行视频风格</label>
          <PresetPicker presets={SHORTVIDEO_STYLE_PRESETS} value={directorRef} onChange={setDirectorRef} placeholder="输入自定义风格..." />
        </div>

        {/* Emphasis Dimensions */}
        <div className="mb-6">
          <label className={`${labelClass} mb-2`}>提示词重点维度</label>
          <p className="text-xs text-text-muted mb-3">选择 0-1 项效果最佳，≥2 项时小鸭生成准确度可能下降</p>
          <div className="space-y-2">
            {EMPHASIS_DIMENSIONS.map((dim) => (
              <label key={dim.key} className="flex items-start gap-3 p-2 rounded hover:bg-bg-dark/50 cursor-pointer">
                <input
                  type="checkbox"
                  checked={emphasisKeys.includes(dim.key)}
                  onChange={() => handleToggleEmphasis(dim.key)}
                  className="mt-0.5"
                />
                <div>
                  <span className="text-sm text-text-dark">{dim.label}</span>
                  <p className="text-xs text-text-muted">{dim.desc}</p>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-2 border-t border-border-dark">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-text-muted hover:text-text-dark transition-colors"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className="px-4 py-2 bg-accent text-white rounded hover:bg-accent/85 transition-colors"
          >
            确认
          </button>
        </div>
      </div>
    </div>
  );
}
