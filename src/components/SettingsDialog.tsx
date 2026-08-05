import { useState, useCallback, useEffect } from 'react';
import { X, FolderOpen, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getVersion } from '@tauri-apps/api/app';
import { open } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import { useSettingsStore } from '@/stores/settingsStore';
import { UiCheckbox, UiSelect } from '@/components/ui';
import { UI_CONTENT_OVERLAY_INSET_CLASS, UI_DIALOG_TRANSITION_MS } from '@/components/ui/motion';
import { useDialogTransition } from '@/components/ui/useDialogTransition';
import type { SettingsCategory } from '@/features/settings/settingsEvents';
import type { BananaUserInfo, SyncStatus } from '@/commands/ai';
import { syncPull } from '@/commands/ai';
import { applySyncSettings } from '@/components/SyncStatus';
import { useProjectStore } from '@/stores/projectStore';
import { useChatStore } from '@/stores/chatStore';
import { hydrateVideoGenStore, useVideoGenStore } from '@/features/videoGeneration/videoGenStore';
import { RechargeDialog } from '@/components/RechargeDialog';
import { ConsumptionHistoryDialog } from '@/components/ConsumptionHistoryDialog';

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  initialCategory?: SettingsCategory;
  userInfo?: BananaUserInfo | null;
  onLogout?: () => void;
  onRefreshCredits?: () => void;
  onGoToLogin?: () => void;
  onOpenDistribution?: () => void;
}

interface SettingsCheckboxCardProps {
  title: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

function SettingsCheckboxCard({
  title,
  description,
  checked,
  onCheckedChange,
}: SettingsCheckboxCardProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onCheckedChange(!checked)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onCheckedChange(!checked);
        }
      }}
      className="w-full rounded-lg border border-border-dark bg-bg-dark p-4 text-left transition-colors hover:border-[rgba(255,255,255,0.2)]"
    >
      <div className="flex items-start gap-3">
        <UiCheckbox
          checked={checked}
          onCheckedChange={(nextChecked) => onCheckedChange(nextChecked)}
          onClick={(event) => event.stopPropagation()}
          className="mt-0.5 shrink-0"
        />
        <div>
          <h3 className="text-sm font-medium text-text-dark">{title}</h3>
          <p className="mt-1 text-xs text-text-muted">{description}</p>
        </div>
      </div>
    </div>
  );
}

export function SettingsDialog({
  isOpen,
  onClose,
  initialCategory = 'general',
  userInfo = null,
  onLogout,
  onRefreshCredits,
  onGoToLogin,
}: SettingsDialogProps) {
  const { t, i18n: _i18n } = useTranslation();
  const {
    grsaiNanoBananaProModel,
    hideProviderGuidePopover: _hideProviderGuidePopover,
    downloadPresetPaths,
    useUploadFilenameAsNodeTitle,
    storyboardGenKeepStyleConsistent,
    storyboardGenDisableTextInImage,
    storyboardGenAutoInferEmptyFrame,
    ignoreAtTagWhenCopyingAndGenerating,
    enableStoryboardGenGridPreviewShortcut,
    showStoryboardGenAdvancedRatioControls,
    deepseekPromptOptimization,
    storyboardGenEnableTopDownMap,
    uiRadiusPreset,
    themeTonePreset,
    accentColor,
    canvasEdgeRoutingMode,
    setGrsaiNanoBananaProModel,
    setDownloadPresetPaths,
    setUseUploadFilenameAsNodeTitle,
    setStoryboardGenKeepStyleConsistent,
    setStoryboardGenDisableTextInImage,
    setStoryboardGenAutoInferEmptyFrame,
    setStoryboardGenEnableTopDownMap,
    setIgnoreAtTagWhenCopyingAndGenerating,
    setEnableStoryboardGenGridPreviewShortcut,
    setShowStoryboardGenAdvancedRatioControls,
    setDeepseekPromptOptimization,
    setUiRadiusPreset,
    setThemeTonePreset,
    setAccentColor,
    setCanvasEdgeRoutingMode,
  } = useSettingsStore();
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>(initialCategory);
  const [isRechargeOpen, setIsRechargeOpen] = useState(false);
  const [syncState, setSyncState] = useState<'idle' | 'syncing' | 'synced' | 'error'>('idle');
  const [syncProgress, setSyncProgress] = useState<{ current: number; total: number; label: string; direction: string } | null>(null);
  const [showSyncRestartHint, setShowSyncRestartHint] = useState(false);
  const [isConsumptionOpen, setIsConsumptionOpen] = useState(false);
  const [_appVersion, setAppVersion] = useState<string>('');
  const [localGrsaiNanoBananaProModel, setLocalGrsaiNanoBananaProModel] = useState(
    grsaiNanoBananaProModel
  );
  const [localDownloadPathInput, setLocalDownloadPathInput] = useState('');
  const [localDownloadPresetPaths, setLocalDownloadPresetPaths] = useState(downloadPresetPaths);
  const [localUseUploadFilenameAsNodeTitle, setLocalUseUploadFilenameAsNodeTitle] = useState(
    useUploadFilenameAsNodeTitle
  );
  const [localStoryboardGenKeepStyleConsistent, setLocalStoryboardGenKeepStyleConsistent] =
    useState(storyboardGenKeepStyleConsistent);
  const [localStoryboardGenDisableTextInImage, setLocalStoryboardGenDisableTextInImage] = useState(
    storyboardGenDisableTextInImage
  );
  const [localStoryboardGenAutoInferEmptyFrame, setLocalStoryboardGenAutoInferEmptyFrame] = useState(
    storyboardGenAutoInferEmptyFrame
  );
  const [localIgnoreAtTagWhenCopyingAndGenerating, setLocalIgnoreAtTagWhenCopyingAndGenerating] =
    useState(ignoreAtTagWhenCopyingAndGenerating);
  const [localEnableStoryboardGenGridPreviewShortcut, setLocalEnableStoryboardGenGridPreviewShortcut] =
    useState(enableStoryboardGenGridPreviewShortcut);
  const [localShowStoryboardGenAdvancedRatioControls, setLocalShowStoryboardGenAdvancedRatioControls] =
    useState(showStoryboardGenAdvancedRatioControls);
  const [localDeepseekPromptOptimization, setLocalDeepseekPromptOptimization] =
    useState(deepseekPromptOptimization);
  const [localStoryboardGenEnableTopDownMap, setLocalStoryboardGenEnableTopDownMap] =
    useState(storyboardGenEnableTopDownMap);
  const [localUiRadiusPreset, setLocalUiRadiusPreset] = useState(uiRadiusPreset);
  const [localThemeTonePreset, setLocalThemeTonePreset] = useState(themeTonePreset);
  const [localAccentColor, setLocalAccentColor] = useState(accentColor);
  const [localCanvasEdgeRoutingMode, setLocalCanvasEdgeRoutingMode] = useState(canvasEdgeRoutingMode);

  const { shouldRender, isVisible } = useDialogTransition(isOpen, UI_DIALOG_TRANSITION_MS);

  useEffect(() => {
    let mounted = true;
    const loadAppVersion = async () => {
      try {
        const version = await getVersion();
        if (mounted) {
          setAppVersion(version);
        }
      } catch {
        if (mounted) {
          setAppVersion('');
        }
      }
    };
    void loadAppVersion();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setLocalDownloadPresetPaths(downloadPresetPaths);
    setLocalGrsaiNanoBananaProModel(grsaiNanoBananaProModel);
    setLocalUseUploadFilenameAsNodeTitle(useUploadFilenameAsNodeTitle);
    setLocalStoryboardGenKeepStyleConsistent(storyboardGenKeepStyleConsistent);
    setLocalStoryboardGenDisableTextInImage(storyboardGenDisableTextInImage);
    setLocalStoryboardGenAutoInferEmptyFrame(storyboardGenAutoInferEmptyFrame);
    setLocalIgnoreAtTagWhenCopyingAndGenerating(ignoreAtTagWhenCopyingAndGenerating);
    setLocalEnableStoryboardGenGridPreviewShortcut(enableStoryboardGenGridPreviewShortcut);
    setLocalShowStoryboardGenAdvancedRatioControls(showStoryboardGenAdvancedRatioControls);
    setLocalUiRadiusPreset(uiRadiusPreset);
    setLocalThemeTonePreset(themeTonePreset);
    setLocalAccentColor(accentColor);
    setLocalCanvasEdgeRoutingMode(canvasEdgeRoutingMode);
    setLocalDownloadPathInput('');
  }, [
    isOpen,
  ]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setActiveCategory(initialCategory);
  }, [initialCategory, isOpen]);

  // 只监听下载进度
  useEffect(() => {
    const unlisten = listen<{ current: number; total: number; label: string; direction: string }>('sync-progress', (event) => {
      if (event.payload.direction === 'pull') {
        setSyncProgress(event.payload);
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // 下载完成或出错时清除进度条
  useEffect(() => {
    if (syncState === 'synced' || syncState === 'error' || syncState === 'idle') {
      setSyncProgress(null);
    }
  }, [syncState]);

  const handleSave = useCallback(() => {
    setGrsaiNanoBananaProModel(localGrsaiNanoBananaProModel);
    setDownloadPresetPaths(localDownloadPresetPaths);
    setUseUploadFilenameAsNodeTitle(localUseUploadFilenameAsNodeTitle);
    setStoryboardGenKeepStyleConsistent(localStoryboardGenKeepStyleConsistent);
    setStoryboardGenDisableTextInImage(localStoryboardGenDisableTextInImage);
    setStoryboardGenAutoInferEmptyFrame(localStoryboardGenAutoInferEmptyFrame);
    setStoryboardGenEnableTopDownMap(localStoryboardGenEnableTopDownMap);
    setIgnoreAtTagWhenCopyingAndGenerating(localIgnoreAtTagWhenCopyingAndGenerating);
    setEnableStoryboardGenGridPreviewShortcut(localEnableStoryboardGenGridPreviewShortcut);
    setShowStoryboardGenAdvancedRatioControls(localShowStoryboardGenAdvancedRatioControls);
    setDeepseekPromptOptimization(localDeepseekPromptOptimization);
    setStoryboardGenEnableTopDownMap(localStoryboardGenEnableTopDownMap);
    setUiRadiusPreset(localUiRadiusPreset);
    setThemeTonePreset(localThemeTonePreset);
    setAccentColor(localAccentColor);
    setCanvasEdgeRoutingMode(localCanvasEdgeRoutingMode);
    onClose();
  }, [
    localDownloadPresetPaths,
    localGrsaiNanoBananaProModel,
    localUseUploadFilenameAsNodeTitle,
    localStoryboardGenKeepStyleConsistent,
    localStoryboardGenDisableTextInImage,
    localStoryboardGenAutoInferEmptyFrame,
    localIgnoreAtTagWhenCopyingAndGenerating,
    localEnableStoryboardGenGridPreviewShortcut,
    localShowStoryboardGenAdvancedRatioControls,
    localDeepseekPromptOptimization,
    localUiRadiusPreset,
    localThemeTonePreset,
    localAccentColor,
    localCanvasEdgeRoutingMode,
    setGrsaiNanoBananaProModel,
    setDownloadPresetPaths,
    setUseUploadFilenameAsNodeTitle,
    setStoryboardGenKeepStyleConsistent,
    setStoryboardGenDisableTextInImage,
    setStoryboardGenAutoInferEmptyFrame,
    setStoryboardGenEnableTopDownMap,
    setIgnoreAtTagWhenCopyingAndGenerating,
    setEnableStoryboardGenGridPreviewShortcut,
    setShowStoryboardGenAdvancedRatioControls,
    setDeepseekPromptOptimization,
    setUiRadiusPreset,
    setThemeTonePreset,
    setAccentColor,
    setCanvasEdgeRoutingMode,
    onClose,
  ]);


  const handlePickDownloadPath = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
      });
      if (!selected || Array.isArray(selected)) {
        return;
      }
      setLocalDownloadPresetPaths((previous) => {
        if (previous.includes(selected)) {
          return previous;
        }
        return [...previous, selected].slice(0, 8);
      });
    } catch (error) {
      console.error('Failed to pick download path', error);
    }
  }, []);

  const handleAddDownloadPathFromInput = useCallback(() => {
    const next = localDownloadPathInput.trim();
    if (!next) {
      return;
    }
    setLocalDownloadPresetPaths((previous) => {
      if (previous.includes(next)) {
        return previous;
      }
      return [...previous, next].slice(0, 8);
    });
    setLocalDownloadPathInput('');
  }, [localDownloadPathInput]);

  const handleRemoveDownloadPath = useCallback((path: string) => {
    setLocalDownloadPresetPaths((previous) => previous.filter((value) => value !== path));
  }, []);


  if (!shouldRender) return null;

  return (
    <>
    <div className={`fixed ${UI_CONTENT_OVERLAY_INSET_CLASS} z-50 flex items-center justify-center`}>
      <div
        className={`absolute inset-0 bg-black/90 transition-opacity duration-200 ${isVisible ? 'opacity-100' : 'opacity-0'}`}
        onClick={onClose}
      />
      <div className="relative w-[min(96vw,1120px)]">
        <div
          className={`relative mx-auto h-[500px] w-[700px] overflow-hidden rounded-lg border border-border-dark bg-surface-dark shadow-xl transition-opacity duration-200 ${isVisible ? 'opacity-100' : 'opacity-0'} flex`}
        >
          {/* Close button */}
          <button
            onClick={onClose}
            className="absolute top-3 right-3 p-1 hover:bg-bg-dark rounded transition-colors z-10"
          >
            <X className="w-5 h-5 text-text-muted" />
          </button>

          {/* Sidebar */}
          <div className="w-[180px] bg-bg-dark border-r border-border-dark flex flex-col">
            <div className="px-4 py-4">
              <span className="text-xs font-medium text-text-muted uppercase tracking-wider">
                {t('settings.title')}
              </span>
            </div>

            <nav className="flex-1">
              <button
                onClick={() => setActiveCategory('general')}
                className={`
                w-full flex items-center gap-3 px-4 py-2.5 text-left
                transition-colors
                ${activeCategory === 'general'
                    ? 'bg-accent/10 text-text-dark border-l-2 border-accent'
                    : 'text-text-muted hover:bg-bg-dark hover:text-text-dark'
                  }
              `}
              >
                <span className="text-sm">{t('settings.general')}</span>
              </button>

              <button
                onClick={() => setActiveCategory('appearance')}
                className={`
                w-full flex items-center gap-3 px-4 py-2.5 text-left
                transition-colors
                ${activeCategory === 'appearance'
                    ? 'bg-accent/10 text-text-dark border-l-2 border-accent'
                    : 'text-text-muted hover:bg-bg-dark hover:text-text-dark'
                  }
              `}
              >
                <span className="text-sm">{t('settings.appearance')}</span>
              </button>

              <button
                onClick={() => setActiveCategory('experimental')}
                className={`
                w-full flex items-center gap-3 px-4 py-2.5 text-left
                transition-colors
                ${activeCategory === 'experimental'
                    ? 'bg-accent/10 text-text-dark border-l-2 border-accent'
                    : 'text-text-muted hover:bg-bg-dark hover:text-text-dark'
                  }
              `}
              >
                <span className="text-sm">{t('settings.experimental')}</span>
              </button>

              <button
                onClick={() => setActiveCategory('me')}
                className={`
                w-full flex items-center gap-3 px-4 py-2.5 text-left
                transition-colors
                ${activeCategory === 'me'
                    ? 'bg-accent/10 text-text-dark border-l-2 border-accent'
                    : 'text-text-muted hover:bg-bg-dark hover:text-text-dark'
                  }
              `}
              >
                <span className="text-sm">{t('settings.me', '我的')}</span>
              </button>

              <button
                onClick={() => setActiveCategory('about')}
                className={`
                w-full flex items-center gap-3 px-4 py-2.5 text-left
                transition-colors
                ${activeCategory === 'about'
                    ? 'bg-accent/10 text-text-dark border-l-2 border-accent'
                    : 'text-text-muted hover:bg-bg-dark hover:text-text-dark'
                  }
              `}
              >
                <span className="text-sm">{t('settings.about', '关于')}</span>
              </button>
            </nav>
          </div>

          {/* Content */}
          <div className="flex-1 flex flex-col">
            {activeCategory === 'appearance' && (
              <>
                <div className="px-6 py-5 border-b border-border-dark">
                  <h2 className="text-lg font-semibold text-text-dark">
                    {t('settings.appearance')}
                  </h2>
                  <p className="text-sm text-text-muted mt-1">
                    {t('settings.appearanceDesc')}
                  </p>
                </div>

                <div className="ui-scrollbar flex-1 space-y-4 overflow-y-auto p-6">
                  <div className="rounded-lg border border-border-dark bg-bg-dark p-4">
                    <h3 className="text-sm font-medium text-text-dark">
                      {t('settings.radiusPreset')}
                    </h3>
                    <p className="mt-1 text-xs text-text-muted">
                      {t('settings.radiusPresetDesc')}
                    </p>
                    <div className="mt-3">
                      <UiSelect
                        value={localUiRadiusPreset}
                        onChange={(event) =>
                          setLocalUiRadiusPreset(event.target.value as typeof localUiRadiusPreset)
                        }
                        className="h-9 text-sm"
                      >
                        <option value="compact">{t('settings.radiusCompact')}</option>
                        <option value="default">{t('settings.radiusDefault')}</option>
                        <option value="large">{t('settings.radiusLarge')}</option>
                      </UiSelect>
                    </div>
                  </div>

                  <div className="rounded-lg border border-border-dark bg-bg-dark p-4">
                    <h3 className="text-sm font-medium text-text-dark">
                      {t('settings.themeTone')}
                    </h3>
                    <p className="mt-1 text-xs text-text-muted">
                      {t('settings.themeToneDesc')}
                    </p>
                    <div className="mt-3">
                      <UiSelect
                        value={localThemeTonePreset}
                        onChange={(event) =>
                          setLocalThemeTonePreset(event.target.value as typeof localThemeTonePreset)
                        }
                        className="h-9 text-sm"
                      >
                        <option value="neutral">{t('settings.toneNeutral')}</option>
                        <option value="warm">{t('settings.toneWarm')}</option>
                        <option value="cool">{t('settings.toneCool')}</option>
                      </UiSelect>
                    </div>
                  </div>

                  <div className="rounded-lg border border-border-dark bg-bg-dark p-4">
                    <h3 className="text-sm font-medium text-text-dark">
                      {t('settings.edgeRoutingMode')}
                    </h3>
                    <p className="mt-1 text-xs text-text-muted">
                      {t('settings.edgeRoutingModeDesc')}
                    </p>
                    <div className="mt-3">
                      <UiSelect
                        value={localCanvasEdgeRoutingMode}
                        onChange={(event) =>
                          setLocalCanvasEdgeRoutingMode(
                            event.target.value as typeof localCanvasEdgeRoutingMode
                          )
                        }
                        className="h-9 text-sm"
                      >
                        <option value="spline">{t('settings.edgeRoutingSpline')}</option>
                        <option value="orthogonal">{t('settings.edgeRoutingOrthogonal')}</option>
                        <option value="smartOrthogonal">{t('settings.edgeRoutingSmartOrthogonal')}</option>
                      </UiSelect>
                    </div>
                  </div>

                  <div className="rounded-lg border border-border-dark bg-bg-dark p-4">
                    <h3 className="text-sm font-medium text-text-dark">
                      {t('settings.accentColor')}
                    </h3>
                    <p className="mt-1 text-xs text-text-muted">
                      {t('settings.accentColorDesc')}
                    </p>
                    <div className="mt-3 flex items-center gap-2">
                      <input
                        type="color"
                        value={localAccentColor}
                        onChange={(event) => setLocalAccentColor(event.target.value)}
                        className="h-9 w-12 rounded border border-border-dark bg-surface-dark p-1"
                      />
                      <input
                        value={localAccentColor}
                        onChange={(event) => setLocalAccentColor(event.target.value)}
                        placeholder="#3B82F6"
                        className="h-9 flex-1 rounded border border-border-dark bg-surface-dark px-3 text-sm text-text-dark outline-none placeholder:text-text-muted"
                      />
                      <button
                        type="button"
                        className="inline-flex h-9 items-center justify-center rounded border border-border-dark bg-surface-dark px-3 text-xs text-text-dark transition-colors hover:bg-bg-dark"
                        onClick={() => setLocalAccentColor('#3B82F6')}
                      >
                        {t('settings.resetAccentColor')}
                      </button>
                    </div>
                  </div>
                </div>

                <div className="flex justify-end border-t border-border-dark px-6 py-4">
                  <button
                    onClick={handleSave}
                    className="rounded bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/80"
                  >
                    {t('common.save')}
                  </button>
                </div>
              </>
            )}


            {activeCategory === 'general' && (
              <>
                <div className="px-6 py-5 border-b border-border-dark">
                  <h2 className="text-lg font-semibold text-text-dark">
                    {t('settings.general')}
                  </h2>
                  <p className="text-sm text-text-muted mt-1">
                    {t('settings.generalDesc')}
                  </p>
                </div>

                <div className="ui-scrollbar flex-1 space-y-4 overflow-y-auto p-6">
                  <SettingsCheckboxCard
                    checked={localStoryboardGenKeepStyleConsistent}
                    onCheckedChange={setLocalStoryboardGenKeepStyleConsistent}
                    title={t('settings.storyboardGenKeepStyleConsistent')}
                    description={t('settings.storyboardGenKeepStyleConsistentDesc')}
                  />

                  <SettingsCheckboxCard
                    checked={localIgnoreAtTagWhenCopyingAndGenerating}
                    onCheckedChange={setLocalIgnoreAtTagWhenCopyingAndGenerating}
                    title={t('settings.ignoreAtTagWhenCopyingAndGenerating')}
                    description={t('settings.ignoreAtTagWhenCopyingAndGeneratingDesc')}
                  />

                  <SettingsCheckboxCard
                    checked={localStoryboardGenDisableTextInImage}
                    onCheckedChange={setLocalStoryboardGenDisableTextInImage}
                    title={t('settings.storyboardGenDisableTextInImage')}
                    description={t('settings.storyboardGenDisableTextInImageDesc')}
                  />

                  <SettingsCheckboxCard
                    checked={localUseUploadFilenameAsNodeTitle}
                    onCheckedChange={setLocalUseUploadFilenameAsNodeTitle}
                    title={t('settings.useUploadFilenameAsNodeTitle')}
                    description={t('settings.useUploadFilenameAsNodeTitleDesc')}
                  />

                  <div className="rounded-lg border border-border-dark bg-bg-dark p-4">
                    <div className="mb-3">
                      <h3 className="text-sm font-medium text-text-dark">
                        {t('settings.downloadPresetPaths')}
                      </h3>
                      <p className="mt-1 text-xs text-text-muted">
                        {t('settings.downloadPresetPathsDesc')}
                      </p>
                    </div>

                    <div className="mb-2 flex items-center gap-2">
                      <input
                        value={localDownloadPathInput}
                        onChange={(event) => setLocalDownloadPathInput(event.target.value)}
                        placeholder={t('settings.downloadPathPlaceholder')}
                        className="h-9 flex-1 rounded border border-border-dark bg-surface-dark px-3 text-sm text-text-dark outline-none placeholder:text-text-muted"
                      />
                      <button
                        type="button"
                        className="inline-flex h-9 items-center justify-center rounded border border-border-dark bg-surface-dark px-3 text-xs text-text-dark transition-colors hover:bg-bg-dark"
                        onClick={handleAddDownloadPathFromInput}
                      >
                        <Plus className="mr-1 h-3.5 w-3.5" />
                        {t('settings.addPath')}
                      </button>
                      <button
                        type="button"
                        className="inline-flex h-9 items-center justify-center rounded border border-border-dark bg-surface-dark px-3 text-xs text-text-dark transition-colors hover:bg-bg-dark"
                        onClick={() => {
                          void handlePickDownloadPath();
                        }}
                      >
                        <FolderOpen className="mr-1 h-3.5 w-3.5" />
                        {t('settings.chooseFolder')}
                      </button>
                    </div>

                    <div className="space-y-1">
                      {localDownloadPresetPaths.length > 0 ? (
                        localDownloadPresetPaths.map((path) => (
                          <div
                            key={path}
                            className="flex items-center gap-2 rounded border border-border-dark bg-surface-dark px-2 py-1.5"
                          >
                            <span className="truncate text-xs text-text-dark">{path}</span>
                            <button
                              type="button"
                              className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark"
                              onClick={() => handleRemoveDownloadPath(path)}
                              title={t('common.delete')}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ))
                      ) : (
                        <div className="text-xs text-text-muted">{t('settings.noDownloadPresetPaths')}</div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex justify-end border-t border-border-dark px-6 py-4">
                  <button
                    onClick={handleSave}
                    className="rounded bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/80"
                  >
                    {t('common.save')}
                  </button>
                </div>
              </>
            )}

            {activeCategory === 'experimental' && (
              <>
                <div className="px-6 py-5 border-b border-border-dark">
                  <h2 className="text-lg font-semibold text-text-dark">
                    {t('settings.experimental')}
                  </h2>
                  <p className="text-sm text-text-muted mt-1">
                    {t('settings.experimentalDesc')}
                  </p>
                </div>

                <div className="ui-scrollbar flex-1 space-y-4 overflow-y-auto p-6">
                  <SettingsCheckboxCard
                    checked={localEnableStoryboardGenGridPreviewShortcut}
                    onCheckedChange={setLocalEnableStoryboardGenGridPreviewShortcut}
                    title={t('settings.enableStoryboardGenGridPreviewShortcut')}
                    description={t('settings.enableStoryboardGenGridPreviewShortcutDesc')}
                  />

                  <SettingsCheckboxCard
                    checked={localShowStoryboardGenAdvancedRatioControls}
                    onCheckedChange={setLocalShowStoryboardGenAdvancedRatioControls}
                    title={t('settings.showStoryboardGenAdvancedRatioControls')}
                    description={t('settings.showStoryboardGenAdvancedRatioControlsDesc')}
                  />

                  <SettingsCheckboxCard
                    checked={localDeepseekPromptOptimization}
                    onCheckedChange={setLocalDeepseekPromptOptimization}
                    title={t('settings.deepseekPromptOptimization')}
                    description={t('settings.deepseekPromptOptimizationDesc')}
                  />

                  <SettingsCheckboxCard
                    checked={localStoryboardGenAutoInferEmptyFrame}
                    onCheckedChange={setLocalStoryboardGenAutoInferEmptyFrame}
                    title={t('settings.storyboardGenAutoInferEmptyFrame')}
                    description={t('settings.storyboardGenAutoInferEmptyFrameDesc')}
                  />

                  <SettingsCheckboxCard
                    checked={localStoryboardGenEnableTopDownMap}
                    onCheckedChange={setLocalStoryboardGenEnableTopDownMap}
                    title={t('node.sceneMarkerEditor.enableTopDownMap')}
                    description={t('node.sceneMarkerEditor.enableTopDownMapDesc')}
                  />
                </div>

                <div className="flex justify-end border-t border-border-dark px-6 py-4">
                  <button
                    onClick={handleSave}
                    className="rounded bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/80"
                  >
                    {t('common.save')}
                  </button>
                </div>
              </>
            )}

            {activeCategory === 'me' && (
              <>
                <div className="px-6 py-5 border-b border-border-dark">
                  <h2 className="text-lg font-semibold text-text-dark">
                    {t('settings.me', '我的')}
                  </h2>
                  <p className="text-sm text-text-muted mt-1">
                    {t('settings.meDesc', '查看您的账户信息和剩余次数')}
                  </p>
                </div>

                <div className="ui-scrollbar flex-1 space-y-4 overflow-y-auto p-6">
                  {userInfo ? (
                    <div className="space-y-4">
                      {/* 用户基本信息卡片 */}
                      <div className="rounded-lg border border-border-dark bg-bg-dark p-4 space-y-4">
                        <div className="flex items-start gap-4">
                          <div className="flex-shrink-0">
                            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-accent/10 text-accent text-2xl font-semibold">
                              {userInfo.username.charAt(0).toUpperCase()}
                            </div>
                          </div>
                          <div className="min-w-0 flex-1">
                            <h3 className="text-lg font-semibold text-text-dark">
                              {userInfo.username}
                            </h3>
                            <p className="text-sm text-text-muted mt-1">
                              {userInfo.email}
                            </p>
                            <div className="flex items-center gap-2 mt-2 flex-wrap">
                              <span className={`inline-flex items-center px-2 py-1 rounded text-xs font-medium ${userInfo.is_active ? 'bg-green-500/10 text-green-600 dark:text-green-400' : 'bg-red-500/10 text-red-600 dark:text-red-400'}`}>
                                {userInfo.is_active ? t('settings.meAccountActive', '账户激活') : t('settings.meAccountInactive', '账户未激活')}
                              </span>
                              <span className={`inline-flex items-center px-2 py-1 rounded text-xs font-medium ${userInfo.is_account_active ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400' : 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400'}`}>
                                {userInfo.is_account_active ? t('settings.meSkillEnabled', '技能可用') : t('settings.meSkillDisabled', '技能禁用')}
                              </span>
                              <button
                                type="button"
                                onClick={async () => {
                                  setSyncState('syncing');
                                  // 同步前先 flush 内存中的数据到文件，防止 merge 覆盖未落盘数据
                                  if ((window as any).__flushChatNowAsync__) {
                                    await (window as any).__flushChatNowAsync__();
                                  }
                                  if ((window as any).__flushProjectPersistsAndWait__) {
                                    await (window as any).__flushProjectPersistsAndWait__();
                                  }
                                  if ((window as any).__forcePersistVideoGenAsync__) {
                                    await (window as any).__forcePersistVideoGenAsync__();
                                  }
                                  try {
                                    const result: SyncStatus = await syncPull();
                                    console.log('[sync][DEBUG] pull result:', JSON.stringify(result));
                                    setSyncState(result.state === 'error' ? 'error' : 'synced');
                                    if (result.state !== 'error') {
                                      console.log('[sync][DEBUG] pull OK, rehydrating stores...');
                                      await applySyncSettings();
                                      await useProjectStore.getState().forceRehydrate();
                                      await useChatStore.getState().forceRehydrate();
                                      useVideoGenStore.setState({ _hydrated: false });
                                      await hydrateVideoGenStore();
                                      console.log('[sync][DEBUG] rehydrate done, chat convos:', useChatStore.getState().conversations.length, 'vg configs:', Object.keys(useVideoGenStore.getState().configs).length);
                                      setShowSyncRestartHint(true);
                                    }
                                  } catch (e) {
                                    setSyncState('error');
                                  }
                                  setTimeout(() => setSyncState('idle'), 3000);
                                }}
                                disabled={syncState === 'syncing'}
                                className={`inline-flex items-center px-2 py-1 rounded text-xs font-medium transition-colors ${
                                  syncState === 'syncing'
                                    ? 'bg-accent/10 text-accent cursor-wait'
                                    : syncState === 'synced'
                                    ? 'bg-green-500/10 text-green-600 dark:text-green-400'
                                    : syncState === 'error'
                                    ? 'bg-red-500/10 text-red-600 dark:text-red-400'
                                    : 'bg-purple-500/10 text-purple-600 dark:text-purple-400 hover:bg-purple-500/20 cursor-pointer'
                                }`}
                              >
                                {syncState === 'syncing'
                                  ? t('settings.meSyncFromCloudSyncing', '同步中...')
                                  : syncState === 'synced'
                                  ? t('settings.meSyncFromCloudDone', '同步完成')
                                  : syncState === 'error'
                                  ? t('settings.meSyncFromCloudError', '失败重试')
                                  : t('settings.meSyncFromCloud', '从云端同步')}
                              </button>

                              {/* 下载进度条 */}
                              {syncProgress && (
                                <div className="flex items-center gap-2 mt-2">
                                  <div className="flex-1 h-1.5 rounded-full bg-surface-dark overflow-hidden">
                                    <div
                                      className="h-full rounded-full bg-accent transition-all duration-300"
                                      style={{ width: `${syncProgress.total > 0 ? (syncProgress.current / syncProgress.total) * 100 : 0}%` }}
                                    />
                                  </div>
                                  <span className="text-[10px] text-text-muted whitespace-nowrap">
                                    {syncProgress.current}/{syncProgress.total}
                                  </span>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* 次数信息卡片 */}
                      <div className="rounded-lg border border-border-dark bg-bg-dark p-4 space-y-4">
                        <h4 className="text-base font-semibold text-text-dark">
                          {t('settings.meCreditsTitle', '剩余次数')}
                        </h4>
                        <div className="grid grid-cols-1 gap-3">
                          <div className="text-center">
                            <div className="text-2xl font-bold text-accent">
                              {userInfo.credits}
                            </div>
                            <div className="text-xs text-text-muted mt-1">
                              {t('settings.meRemainingCredits', '剩余')}
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* 操作按钮 */}
                      <div className="rounded-lg border border-border-dark bg-bg-dark p-4 space-y-3">
                        <h4 className="text-base font-semibold text-text-dark">
                          {t('settings.meActions', '账户操作')}
                        </h4>
                        <div className="flex flex-col gap-2">
                          <button
                            type="button"
                            onClick={() => setIsConsumptionOpen(true)}
                            className="w-full rounded border border-border-dark bg-surface-dark px-4 py-2.5 text-sm font-medium text-text-dark transition-colors hover:bg-bg-dark"
                          >
                            {t('settings.meConsumptionList', '消费清单')}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (onRefreshCredits) {
                                onRefreshCredits();
                              }
                            }}
                            className="w-full rounded border border-border-dark bg-surface-dark px-4 py-2.5 text-sm font-medium text-text-dark transition-colors hover:bg-bg-dark"
                          >
                            {t('settings.meRefreshCredits', '刷新剩余积分')}
                          </button>
                          <button
                            type="button"
                            onClick={() => setIsRechargeOpen(true)}
                            className="w-full rounded border border-border-dark bg-surface-dark px-4 py-2.5 text-sm font-medium text-text-dark transition-colors hover:bg-bg-dark"
                          >
                            {t('settings.meRecharge', '充值')}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (onLogout) {
                                onLogout();
                              }
                            }}
                            className="w-full rounded border border-red-500/20 bg-red-500/10 px-4 py-2.5 text-sm font-medium text-red-600 dark:text-red-400 transition-colors hover:bg-red-500/20"
                          >
                            {t('settings.meLogout', '退出登录')}
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-lg border border-border-dark bg-bg-dark p-4 space-y-4">
                      <div className="text-center">
                        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-accent/10 text-accent text-2xl font-semibold">
                          U
                        </div>
                        <p className="mt-3 text-sm text-text-muted">
                          {t('settings.meLoginPrompt', '请先登录以查看账户信息')}
                        </p>
                        <button
                          type="button"
                          onClick={() => {
                            if (onGoToLogin) {
                              onGoToLogin();
                            } else {
                              onClose(); // 如果没有提供处理函数，只关闭设置对话框
                            }
                          }}
                          className="mt-4 rounded bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90"
                        >
                          {t('settings.meGoToLogin', '去登录')}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}

            {activeCategory === 'about' && (
              <>
                <div className="px-6 py-5 border-b border-border-dark">
                  <h2 className="text-lg font-semibold text-text-dark">
                    {t('settings.about', '关于')}
                  </h2>
                  <p className="text-sm text-text-muted mt-1">
                    {t('settings.aboutDesc', '应用信息')}
                  </p>
                </div>

                <div className="ui-scrollbar flex-1 overflow-y-auto p-6">
                  <div className="rounded-lg border border-border-dark bg-bg-dark p-6">
                    <div className="text-center mb-6">
                      <p className="text-lg font-semibold text-text-dark">
                        小鸭分镜大师旅游版
                      </p>
                      <p className="text-sm text-text-muted mt-1">
                        内部测试版 {_appVersion || t('settings.aboutVersionUnknown', '未知')}
                      </p>
                    </div>

                    <div className="space-y-1 text-sm text-text-dark font-medium">
                      <p>Core Data Development: Little Duck Development Team</p>
                      <p>Rule Development: Little Duck AI Rule Team</p>
                      <p>Video Data Weighting: Little Duck Data Group</p>
                      <p>Core Constraint Development: Little Duck Film and Television Team</p>
                      <p>Complete Code LICENSE: Copyright &copy; Little Duck Film and Television Data Team</p>
                      <p>Baseplate LICENSE: Copyright Mathias Bynens &lt;https://mathiasbynens.be/&gt;</p>
                    </div>

                    <div className="mt-6 text-xs text-text-muted whitespace-pre-line leading-relaxed">
                      <p className="mb-4">
                        Permission is hereby granted, free of charge, to any person obtaining
                        a copy of this software and associated documentation files (the
                        &ldquo;Software&rdquo;), to deal in the Software without restriction, including
                        without limitation the rights to use, copy, modify, merge, publish,
                        distribute, sublicense, and/or sell copies of the Software, and to
                        permit persons to whom the Software is furnished to do so, subject to
                        the following conditions:
                      </p>

                      <p className="mb-4">
                        The above copyright notice and this permission notice shall be
                        included in all copies or substantial portions of the Software.
                      </p>

                      <p>
                        THE SOFTWARE IS PROVIDED &ldquo;AS IS&rdquo;, WITHOUT WARRANTY OF ANY KIND,
                        EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
                        MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
                        NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
                        LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
                        OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
                        WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
                      </p>
                    </div>
                  </div>
                </div>
              </>
            )}

          </div>
        </div>
        {/* Removed the provider guide popover since we no longer have the providers tab */}
      </div>
    </div>
    <ConsumptionHistoryDialog
      isOpen={isConsumptionOpen}
      onClose={() => setIsConsumptionOpen(false)}
    />
    <RechargeDialog
      isOpen={isRechargeOpen}
      onClose={() => setIsRechargeOpen(false)}
      onPaid={() => {
        if (onRefreshCredits) onRefreshCredits();
      }}
    />
    {/* 同步完成提示：需重启生效 */}
    {showSyncRestartHint && (
      <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm">
        <div className="w-[400px] max-w-[90vw] rounded-2xl border border-[rgba(255,255,255,0.12)] bg-surface-dark p-6 shadow-2xl">
          <h3 className="mb-3 text-base font-semibold text-text-dark">
            {t('settings.meSyncRestartTitle', '同步完成')}
          </h3>
          <p className="mb-5 text-sm leading-6 text-text-muted">
            {t('settings.meSyncRestartHint', '数据已从云端同步到本地。请重新打开分镜大师，即可看到恢复的项目、对话和视频数据。')}
          </p>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setShowSyncRestartHint(false)}
              className="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-white transition-colors hover:opacity-90"
            >
              {t('settings.meSyncRestartConfirm', '知道了')}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}