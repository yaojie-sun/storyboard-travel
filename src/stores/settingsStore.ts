import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type UiRadiusPreset = 'compact' | 'default' | 'large';
export type ThemeTonePreset = 'neutral' | 'warm' | 'cool';
export type CanvasEdgeRoutingMode = 'spline' | 'orthogonal' | 'smartOrthogonal';

interface SettingsState {
  apiKeys: Record<string, string>;
  grsaiNanoBananaProModel: string;
  hideProviderGuidePopover: boolean;
  downloadPresetPaths: string[];
  useUploadFilenameAsNodeTitle: boolean;
  storyboardGenKeepStyleConsistent: boolean;
  storyboardGenDisableTextInImage: boolean;
  storyboardGenAutoInferEmptyFrame: boolean;
  storyboardGenEnableTopDownMap: boolean;
  ignoreAtTagWhenCopyingAndGenerating: boolean;
  enableStoryboardGenGridPreviewShortcut: boolean;
  showStoryboardGenAdvancedRatioControls: boolean;
  deepseekPromptOptimization: boolean;
  showNodePrice: boolean;
  priceDisplayCurrencyMode: 'auto' | 'cny' | 'usd';
  usdToCnyRate: number;
  preferDiscountedPrice: boolean;
  grsaiCreditTierId: 'tier-10' | 'tier-20' | 'tier-49' | 'tier-99' | 'tier-499' | 'tier-999';
  uiRadiusPreset: UiRadiusPreset;
  themeTonePreset: ThemeTonePreset;
  accentColor: string;
  canvasEdgeRoutingMode: CanvasEdgeRoutingMode;

  updateApiKey: (provider: string, key: string) => void;
  setGrsaiNanoBananaProModel: (model: string) => void;
  setHideProviderGuidePopover: (hide: boolean) => void;
  setDownloadPresetPaths: (paths: string[]) => void;
  setUseUploadFilenameAsNodeTitle: (enabled: boolean) => void;
  setStoryboardGenKeepStyleConsistent: (enabled: boolean) => void;
  setStoryboardGenDisableTextInImage: (enabled: boolean) => void;
  setStoryboardGenAutoInferEmptyFrame: (enabled: boolean) => void;
  setStoryboardGenEnableTopDownMap: (enabled: boolean) => void;
  setIgnoreAtTagWhenCopyingAndGenerating: (enabled: boolean) => void;
  setEnableStoryboardGenGridPreviewShortcut: (enabled: boolean) => void;
  setShowStoryboardGenAdvancedRatioControls: (enabled: boolean) => void;
  setDeepseekPromptOptimization: (enabled: boolean) => void;
  setShowNodePrice: (enabled: boolean) => void;
  setPriceDisplayCurrencyMode: (mode: 'auto' | 'cny' | 'usd') => void;
  setUsdToCnyRate: (rate: number) => void;
  setPreferDiscountedPrice: (enabled: boolean) => void;
  setGrsaiCreditTierId: (tierId: 'tier-10' | 'tier-20' | 'tier-49' | 'tier-99' | 'tier-499' | 'tier-999') => void;
  setUiRadiusPreset: (preset: UiRadiusPreset) => void;
  setThemeTonePreset: (preset: ThemeTonePreset) => void;
  setAccentColor: (color: string) => void;
  setCanvasEdgeRoutingMode: (mode: CanvasEdgeRoutingMode) => void;
  setProviderApiKey: (provider: string, key: string) => void;
  getConfiguredApiKeyCount: () => number;
}

const HEX_COLOR_PATTERN = /^#?[0-9a-fA-F]{6}$/;

function normalizeHexColor(input: string): string {
  const trimmed = input.trim();
  if (!HEX_COLOR_PATTERN.test(trimmed)) {
    return '#3B82F6';
  }
  return trimmed.startsWith('#') ? trimmed.toUpperCase() : `#${trimmed.toUpperCase()}`;
}

function normalizePriceDisplayCurrencyMode(input: 'auto' | 'cny' | 'usd' | string | null | undefined): 'auto' | 'cny' | 'usd' {
  if (input === 'auto' || input === 'cny' || input === 'usd') {
    return input;
  }
  return 'auto';
}

function normalizeUsdToCnyRate(input: number | string | null | undefined): number {
  const numeric = typeof input === 'number' ? input : Number(input);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 7.2;
  }

  return Math.min(100, Math.max(0.01, Math.round(numeric * 100) / 100));
}

function normalizeGrsaiCreditTierId(input: 'tier-10' | 'tier-20' | 'tier-49' | 'tier-99' | 'tier-499' | 'tier-999' | string | null | undefined): 'tier-10' | 'tier-20' | 'tier-49' | 'tier-99' | 'tier-499' | 'tier-999' {
  switch (input) {
    case 'tier-10':
    case 'tier-20':
    case 'tier-49':
    case 'tier-99':
    case 'tier-499':
    case 'tier-999':
      return input;
    default:
      return 'tier-10';
  }
}

function normalizeGrsaiNanoBananaProModel(input: string | null | undefined): string {
  const trimmed = (input ?? '').trim().toLowerCase();
  if (trimmed === 'nano-banana-pro' || trimmed.startsWith('nano-banana-pro-')) {
    return trimmed;
  }
  return 'nano-banana-pro';
}

function normalizeCanvasEdgeRoutingMode(input: CanvasEdgeRoutingMode | string | null | undefined): CanvasEdgeRoutingMode {
  if (input === 'orthogonal' || input === 'smartOrthogonal' || input === 'spline') {
    return input;
  }
  return 'spline';
}

// ---- 状态自愈：验证持久化数据的完整性 ----

/** 根态默认值（单一真相源） */
const SETTINGS_DEFAULTS = {
  apiKeys: {} as Record<string, string>,
  grsaiNanoBananaProModel: 'nano-banana-pro',
  hideProviderGuidePopover: false,
  downloadPresetPaths: [] as string[],
  useUploadFilenameAsNodeTitle: true,
  storyboardGenKeepStyleConsistent: true,
  storyboardGenDisableTextInImage: true,
  storyboardGenAutoInferEmptyFrame: true,
  storyboardGenEnableTopDownMap: false,
  ignoreAtTagWhenCopyingAndGenerating: true,
  enableStoryboardGenGridPreviewShortcut: false,
  showStoryboardGenAdvancedRatioControls: false,
  deepseekPromptOptimization: false,
  showNodePrice: false,
  priceDisplayCurrencyMode: 'auto' as const,
  usdToCnyRate: 7.2,
  preferDiscountedPrice: false,
  grsaiCreditTierId: 'tier-10' as const,
  uiRadiusPreset: 'default' as UiRadiusPreset,
  themeTonePreset: 'neutral' as ThemeTonePreset,
  accentColor: '#3B82F6',
  canvasEdgeRoutingMode: 'spline' as CanvasEdgeRoutingMode,
};

/**
 * 在启动时自愈损坏的持久化状态。
 * 如果检测到关键字段类型不正确或缺失，返回干净默认值。
 */
function validateAndRepairState(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    console.error('[SettingsStore] 持久化状态类型异常，重置为默认值', { type: typeof raw });
    return { ...SETTINGS_DEFAULTS };
  }

  const state = raw as Record<string, unknown>;
  let repaired = false;
  let corruptions: string[] = [];

  // 关键字段：apiKeys 必须是普通对象（不能是 null、数组、字符串等）
  if (state.apiKeys !== undefined) {
    if (
      state.apiKeys === null ||
      Array.isArray(state.apiKeys) ||
      typeof state.apiKeys !== 'object'
    ) {
      console.error('[SettingsStore] apiKeys 类型损坏，重置为空对象', { apiKeys: state.apiKeys });
      state.apiKeys = {};
      repaired = true;
      corruptions.push('apiKeys: wrong type');
    }
  }

  // 布尔字段类型校验（如果存在但不是布尔，重置为默认）
  const booleanFields = [
    'hideProviderGuidePopover', 'useUploadFilenameAsNodeTitle',
    'storyboardGenKeepStyleConsistent', 'storyboardGenDisableTextInImage',
    'storyboardGenAutoInferEmptyFrame', 'storyboardGenEnableTopDownMap',
    'ignoreAtTagWhenCopyingAndGenerating', 'enableStoryboardGenGridPreviewShortcut',
    'showStoryboardGenAdvancedRatioControls', 'deepseekPromptOptimization',
    'showNodePrice', 'preferDiscountedPrice',
  ];
  for (const key of booleanFields) {
    if (state[key] !== undefined && typeof state[key] !== 'boolean') {
      console.error(`[SettingsStore] ${key} 类型损坏(${typeof state[key]})，重置默认值`);
      state[key] = (SETTINGS_DEFAULTS as any)[key];
      repaired = true;
      corruptions.push(`${key}: wrong type`);
    }
  }

  // downloadPresetPaths 必须是数组
  if (state.downloadPresetPaths !== undefined && !Array.isArray(state.downloadPresetPaths)) {
    console.error('[SettingsStore] downloadPresetPaths 不是数组，重置');
    state.downloadPresetPaths = [];
    repaired = true;
    corruptions.push('downloadPresetPaths: not array');
  }

  // usdToCnyRate 必须是有效数字
  if (state.usdToCnyRate !== undefined) {
    const n = Number(state.usdToCnyRate);
    if (!Number.isFinite(n) || n <= 0) {
      console.error('[SettingsStore] usdToCnyRate 无效，重置');
      state.usdToCnyRate = 7.2;
      repaired = true;
      corruptions.push('usdToCnyRate: invalid');
    }
  }

  if (repaired) {
    console.warn('[SettingsStore] 状态自愈完成，修复字段:', corruptions.join(', '));
  }

  return state;
}

function buildInitialState(set: any): SettingsState {
  return {
    ...SETTINGS_DEFAULTS,
    updateApiKey: (provider: string, key: string) => set((s: SettingsState) => ({
      apiKeys: { ...s.apiKeys, [provider]: key }
    })),
    setProviderApiKey: (provider: string, key: string) => set((s: SettingsState) => ({
      apiKeys: { ...s.apiKeys, [provider]: key }
    })),
    getConfiguredApiKeyCount: () => {
      const s = useSettingsStore.getState();
      try {
        return Object.keys(s.apiKeys || {}).filter(p => (s.apiKeys[p] || '').trim() !== '').length;
      } catch {
        return 0;
      }
    },
    setGrsaiNanoBananaProModel: (model: string) => set({ grsaiNanoBananaProModel: normalizeGrsaiNanoBananaProModel(model) }),
    setHideProviderGuidePopover: (hide: boolean) => set({ hideProviderGuidePopover: hide }),
    setDownloadPresetPaths: (paths: string[]) => {
      const uniquePaths = Array.from(new Set(paths.map(p => p.trim()).filter(p => p.length > 0))).slice(0, 8);
      set({ downloadPresetPaths: uniquePaths });
    },
    setUseUploadFilenameAsNodeTitle: (enabled: boolean) => set({ useUploadFilenameAsNodeTitle: enabled }),
    setStoryboardGenKeepStyleConsistent: (enabled: boolean) => set({ storyboardGenKeepStyleConsistent: enabled }),
    setStoryboardGenDisableTextInImage: (enabled: boolean) => set({ storyboardGenDisableTextInImage: enabled }),
    setStoryboardGenAutoInferEmptyFrame: (enabled: boolean) => set({ storyboardGenAutoInferEmptyFrame: enabled }),
    setStoryboardGenEnableTopDownMap: (enabled: boolean) => set({ storyboardGenEnableTopDownMap: enabled }),
    setIgnoreAtTagWhenCopyingAndGenerating: (enabled: boolean) => set({ ignoreAtTagWhenCopyingAndGenerating: enabled }),
    setEnableStoryboardGenGridPreviewShortcut: (enabled: boolean) => set({ enableStoryboardGenGridPreviewShortcut: enabled }),
    setShowStoryboardGenAdvancedRatioControls: (enabled: boolean) => set({ showStoryboardGenAdvancedRatioControls: enabled }),
    setDeepseekPromptOptimization: (enabled: boolean) => set({ deepseekPromptOptimization: enabled }),
    setShowNodePrice: (enabled: boolean) => set({ showNodePrice: enabled }),
    setPriceDisplayCurrencyMode: (mode: 'auto' | 'cny' | 'usd') => set({ priceDisplayCurrencyMode: normalizePriceDisplayCurrencyMode(mode) }),
    setUsdToCnyRate: (rate: number) => set({ usdToCnyRate: normalizeUsdToCnyRate(rate) }),
    setPreferDiscountedPrice: (enabled: boolean) => set({ preferDiscountedPrice: enabled }),
    setGrsaiCreditTierId: (tierId: 'tier-10' | 'tier-20' | 'tier-49' | 'tier-99' | 'tier-499' | 'tier-999') => set({ grsaiCreditTierId: normalizeGrsaiCreditTierId(tierId) }),
    setUiRadiusPreset: (preset: UiRadiusPreset) => set({ uiRadiusPreset: preset }),
    setThemeTonePreset: (preset: ThemeTonePreset) => set({ themeTonePreset: preset }),
    setAccentColor: (color: string) => set({ accentColor: normalizeHexColor(color) }),
    setCanvasEdgeRoutingMode: (mode: CanvasEdgeRoutingMode) => set({ canvasEdgeRoutingMode: normalizeCanvasEdgeRoutingMode(mode) }),
  };
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => buildInitialState(set),
    {
      name: 'settings-storage',
      version: 12,
      onRehydrateStorage: () => {
        return (state, error) => {
          if (error) {
            console.error('[SettingsStore] hydration 失败，使用默认值:', error);
          }
          // hydration 完成后再做一次运行时验证
          if (state) {
            try {
              if (state.apiKeys === null || Array.isArray(state.apiKeys) || typeof state.apiKeys !== 'object') {
                console.error('[SettingsStore] 运行时检测到 apiKeys 损坏，紧急修复');
                state.apiKeys = {} as Record<string, string>;
              }
            } catch (e) {
              console.error('[SettingsStore] 运行时验证异常:', e);
            }
          }
        };
      },
      migrate: (persistedState: unknown, _version: number) => {
        try {
          const repaired = validateAndRepairState(persistedState);
          const state = repaired as Record<string, unknown>;

          // 处理旧版单 key: apiKey → apiKeys
          if (state.apiKey && !state.apiKeys) {
            state.apiKeys = { openai: state.apiKey };
          }
          delete state.apiKey;

          // 标准化字段
          return {
            ...state,
            grsaiNanoBananaProModel: normalizeGrsaiNanoBananaProModel(state.grsaiNanoBananaProModel as string),
            canvasEdgeRoutingMode: normalizeCanvasEdgeRoutingMode(state.canvasEdgeRoutingMode as string),
            priceDisplayCurrencyMode: normalizePriceDisplayCurrencyMode(state.priceDisplayCurrencyMode as string),
            usdToCnyRate: normalizeUsdToCnyRate(state.usdToCnyRate as number | string | null | undefined),
            grsaiCreditTierId: normalizeGrsaiCreditTierId(state.grsaiCreditTierId as string),
          };
        } catch (e) {
          console.error('[SettingsStore] migrate 异常，重置为默认值:', e);
          return { ...SETTINGS_DEFAULTS };
        }
      },
      merge: (persistedState: unknown, currentState: SettingsState) => {
        // 合并前先验证持久化数据
        try {
          const repaired = validateAndRepairState(persistedState);
          return { ...currentState, ...repaired };
        } catch (e) {
          console.error('[SettingsStore] merge 异常，使用当前默认值:', e);
          return currentState;
        }
      },
    }
  )
);
