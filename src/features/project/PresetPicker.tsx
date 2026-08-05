import { useState, useEffect } from 'react';

interface PresetPickerProps {
  presets: string[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

/**
 * Grid of preset buttons with an "自定义" option at the end.
 * When "自定义" is selected, shows a text input inline.
 * If the current value doesn't match any preset, auto-activates custom mode.
 */
export function PresetPicker({ presets, value, onChange, placeholder = '输入自定义...' }: PresetPickerProps) {
  const [customInput, setCustomInput] = useState('');
  const [showCustom, setShowCustom] = useState(false);

  // Detect custom mode: value is non-empty and not in presets
  useEffect(() => {
    if (value && !presets.includes(value)) {
      setShowCustom(true);
      setCustomInput(value);
    }
  }, [value, presets]);

  const handlePresetClick = (preset: string) => {
    setShowCustom(false);
    setCustomInput('');
    onChange(preset);
  };

  const handleCustomToggle = () => {
    if (showCustom) {
      // Turning custom off
      setShowCustom(false);
      setCustomInput('');
      onChange('');
    } else {
      setShowCustom(true);
    }
  };

  const buttonClass = (active: boolean) =>
    `px-2.5 py-1 text-xs rounded border transition-colors ${
      active
        ? 'border-accent bg-accent/10 text-accent'
        : 'border-border-dark text-text-muted hover:border-text-muted'
    }`;

  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {presets.map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => handlePresetClick(preset)}
            className={buttonClass(value === preset && !showCustom)}
          >
            {preset}
          </button>
        ))}
        <button
          type="button"
          onClick={handleCustomToggle}
          className={buttonClass(showCustom)}
        >
          {showCustom ? '取消自定义' : '自定义 ✎'}
        </button>
      </div>
      {showCustom && (
        <input
          type="text"
          value={customInput}
          onChange={(e) => {
            setCustomInput(e.target.value);
            onChange(e.target.value);
          }}
          placeholder={placeholder}
          className="mt-2 w-full px-3 py-2 bg-bg-dark border border-border-dark rounded text-text-dark placeholder-text-muted focus:outline-none focus:border-accent text-sm"
          autoFocus
        />
      )}
    </div>
  );
}
