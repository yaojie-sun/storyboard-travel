import { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Settings, Film, RefreshCw } from 'lucide-react';
import { useProjectStore } from '@/stores/projectStore';
import { useEpisodeStore } from '@/stores/episodeStore';
import { useChatStore } from '@/stores/chatStore';
import { UiButton } from '@/components/ui/primitives';
import { RenameDialog } from './RenameDialog';
import { EditParamsDialog } from './EditParamsDialog';
import { EpisodeList } from './EpisodeList';
import { AssetManager } from './AssetManager';
import { ReanalyzeDialog } from './ReanalyzeDialog';
import { buildProjectChatContext } from '@/features/chat/projectContext';

type DialogMode = 'rename' | 'params' | 'reanalyze' | null;

export function ProjectDashboard() {
  const { t } = useTranslation();
  const currentProject = useProjectStore((state) => state.currentProject);
  const closeProject = useProjectStore((state) => state.closeProject);
  const setView = useProjectStore((state) => state.setView);
  const currentEpisodeId = useEpisodeStore((state) => state.currentEpisodeId);
  const setCurrentEpisode = useEpisodeStore((state) => state.setCurrentEpisode);
  const setProjectContext = useChatStore((state) => state.setProjectContext);
  const loadEpisodes = useEpisodeStore((state) => state.loadEpisodes);
  const createEpisode = useEpisodeStore((state) => state.createEpisode);
  const isLoadingEpisodes = useEpisodeStore((state) => state.isLoading);

  const [editingProjectName, setEditingProjectName] = useState('');
  const [dialogMode, setDialogMode] = useState<DialogMode>(null);

  const project = currentProject;
  const projectId = project?.id ?? '';

  console.log('[DEBUG] ProjectDashboard render, currentProject:', project ? `id=${project.id}` : 'null', 'view:', useProjectStore.getState().view);

  // Load episodes on mount
  useEffect(() => {
    if (projectId) {
      void loadEpisodes(projectId);
    }
  }, [projectId, loadEpisodes]);


  // 进入仪表盘时确保第一个子项目存在并聚焦（仅首次，之后尊重用户选择）
  const initialFocusDone = useRef(false);
  const autoCreatedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!projectId) return;

    // 用 getState 读取实时状态，避免 effect 间 render snapshot 竞态：
    // effect 1 的 loadEpisodes() 同步设置 isLoading:true，但 effect 2 在同一
    // render commit 中执行时拿到的仍是旧的 isLoading=false。
    const liveState = useEpisodeStore.getState();
    if (liveState.isLoading) return;

    const eps = liveState.episodesByProject[projectId];
    const len = eps ? eps.length : 0;

    // 无子项目 → 自动创建"子项目1"
    if (len === 0) {
      if (autoCreatedRef.current !== projectId) {
        autoCreatedRef.current = projectId;
        createEpisode(projectId, t('episode.defaultName', { number: 1 }));
      }
      return;
    }

    // 有子项目 → 首次进入聚焦第一个
    if (!initialFocusDone.current) {
      setCurrentEpisode(eps[0].id);
      initialFocusDone.current = true;
    }
  }, [projectId, isLoadingEpisodes, createEpisode, setCurrentEpisode, t]);

  // 切换项目时重置
  useEffect(() => {
    initialFocusDone.current = false;
    autoCreatedRef.current = null;
  }, [projectId]);

  if (!project) {
    console.log('[DEBUG] ProjectDashboard: project is null, returning loading state instead of null');
    // Show loading state instead of black screen
    return (
      <div className="h-full w-full flex items-center justify-center bg-bg-dark">
        <div className="text-text-muted text-sm">加载项目数据...</div>
      </div>
    );
  }

  const enabledDimensions = project.emphasisDimensions.filter((d) => d.enabled);

  const buildAndSetContext = useCallback(async () => {
    const context = await buildProjectChatContext(projectId);
    setProjectContext(context);
  }, [projectId, setProjectContext]);

  const handleEnterCanvas = useCallback(async (episodeId: string) => {
    setCurrentEpisode(episodeId);
    await buildAndSetContext();
    setView('canvas');
  }, [setCurrentEpisode, buildAndSetContext, setView]);

  const handleBack = () => {
    closeProject();
  };

  const handleRenameClick = () => {
    setEditingProjectName(project.name);
    setDialogMode('rename');
  };

  const handleRenameConfirm = (name: string) => {
    // This triggers close and sets view to manager, we need to just rename via the store
    useProjectStore.getState().renameProject(project.id, name);
    setDialogMode(null);
  };

  const handleEditParams = (params: {
    videoType?: string;
    aspectRatio: string;
    style: string;
    tone: string;
    directorRef: string;
    emphasisKeys: string[];
  }) => {
    useProjectStore.getState().updateProjectParams(project.id, params);
  };

  // Parse AI analysis data from aiParams JSON
  const analysisData = useMemo(() => {
    if (!project.aiParams) return null;
    try {
      const parsed = JSON.parse(project.aiParams);
      return parsed as {
        logline?: string;
        genre?: string;
        themes?: string[];
        characters?: { name: string; archetype: string; arc: string }[];
        visual_style?: { color_palette?: string; lighting?: string; camera?: string };
        pacing?: string;
        analysis_summary?: string;
      };
    } catch {
      return null;
    }
  }, [project.aiParams]);

  const paramsList = useMemo(() => {
    const items: { label: string; value: string }[] = [];
    if (project.aspectRatio) items.push({ label: t('projectSetup.aspectRatio'), value: project.aspectRatio });
    if (project.style) items.push({ label: t('projectSetup.style'), value: project.style });
    if (project.tone) items.push({ label: t('projectSetup.tone'), value: project.tone });
    if (project.directorRef) items.push({ label: t('projectSetup.shortVideoStyle'), value: project.directorRef });
    if (enabledDimensions.length > 0) {
      items.push({
        label: t('projectSetup.emphasisDimensions'),
        value: enabledDimensions.map((d) => d.label).join('、'),
      });
    }
    if (analysisData) {
      if (analysisData.logline) items.push({ label: t('projectSetup.logline'), value: analysisData.logline });
      if (analysisData.genre) items.push({ label: t('projectSetup.genre'), value: analysisData.genre });
      if (analysisData.themes && analysisData.themes.length > 0) {
        items.push({ label: t('projectSetup.themes'), value: analysisData.themes.join('、') });
      }
      if (analysisData.characters && analysisData.characters.length > 0) {
        items.push({
          label: t('projectSetup.characters'),
          value: analysisData.characters.map((c) => `${c.name}（${c.archetype}）`).join('、'),
        });
      }
      if (analysisData.pacing) items.push({ label: t('projectSetup.pacing'), value: analysisData.pacing });
      if (analysisData.analysis_summary) items.push({ label: t('projectSetup.summary'), value: analysisData.analysis_summary });
    }
    return items;
  }, [project, enabledDimensions, analysisData, t]);

  return (
    <div className="ui-scrollbar h-full w-full overflow-y-auto">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-surface-dark border-b border-border-dark">
        <div className="max-w-5xl mx-auto px-8 py-3 flex items-center gap-4">
          <button
            type="button"
            onClick={handleBack}
            className="flex items-center gap-1.5 text-text-muted hover:text-text-dark transition-colors text-sm"
          >
            <ArrowLeft className="w-4 h-4" />
            {t('common.back')}
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold text-text-dark truncate">{project.name}</h1>
              <button
                type="button"
                onClick={handleRenameClick}
                className="p-1 hover:bg-bg-dark rounded text-text-muted hover:text-text-dark transition-colors"
                title={t('common.edit')}
              >
                <Settings className="w-3.5 h-3.5" />
              </button>
            </div>
            {paramsList.length > 0 && (
              <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                {paramsList.map((item) => (
                  <span key={item.label} className="text-xs text-text-muted bg-bg-dark/50 px-2 py-0.5 rounded">
                    {item.label}: {item.value.length > 30 ? `${item.value.slice(0, 30)}...` : item.value}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-5xl mx-auto px-8 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left: Episode List */}
          <div className="lg:col-span-1">
            <div className="border border-border-dark rounded-lg p-4 bg-surface-dark">
              <EpisodeList
                projectId={project.id}
                selectedEpisodeId={currentEpisodeId}
                onSelectEpisode={setCurrentEpisode}
                onEnterCanvas={handleEnterCanvas}
              />
            </div>
          </div>

          {/* Right: Main Content Area */}
          <div className="lg:col-span-2 space-y-6">
            {/* Project Params Summary */}
            <div className="border border-border-dark rounded-lg p-4 bg-surface-dark">
              <h3 className="text-sm font-medium text-text-dark mb-3">{t('dashboard.projectParams')}</h3>
              {paramsList.length === 0 ? (
                <p className="text-sm text-text-muted">{t('dashboard.noParams')}</p>
              ) : (
                <div className="space-y-2">
                  {paramsList.map((item) => (
                    <div key={item.label} className="flex gap-3 text-sm">
                      <span className="text-text-muted shrink-0 w-24">{item.label}</span>
                      <span className="text-text-dark">{item.value}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-3 flex gap-2">
                <UiButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setDialogMode('params')}
                  className="gap-1.5"
                >
                  <Settings className="w-3.5 h-3.5" />
                  {t('dashboard.editParams')}
                </UiButton>
                <UiButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setDialogMode('reanalyze')}
                  className="gap-1.5"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  重新分析
                </UiButton>
              </div>
            </div>

            {/* Asset Management */}
            <AssetManager projectId={project.id} />

            {/* Enter Canvas (prominent CTA) */}
            <div className="flex justify-center pt-2">
              <UiButton
                type="button"
                variant="primary"
                size="md"
                onClick={async () => {
                  if (currentEpisodeId) {
                    setCurrentEpisode(currentEpisodeId);
                    await buildAndSetContext();
                    setView('canvas');
                  }
                }}
                disabled={!currentEpisodeId}
                className="gap-2 px-8 py-3 text-base"
              >
                <Film className="w-5 h-5" />
                {t('episode.enterCanvas')}
              </UiButton>
            </div>
          </div>
        </div>
      </div>

      {/* Rename Dialog for project name */}
      <RenameDialog
        isOpen={dialogMode === 'rename'}
        title={t('project.renameTitle')}
        defaultValue={editingProjectName}
        onClose={() => setDialogMode(null)}
        onConfirm={handleRenameConfirm}
      />

      {/* Edit Params Dialog */}
      <EditParamsDialog
        isOpen={dialogMode === 'params'}
        onClose={() => setDialogMode(null)}
        onConfirm={handleEditParams}
        initial={{
          videoType: project.videoType,
          aspectRatio: project.aspectRatio,
          style: project.style,
          tone: project.tone,
          directorRef: project.directorRef,
          emphasisDimensions: project.emphasisDimensions,
        }}
      />

      {/* Reanalyze Dialog */}
      <ReanalyzeDialog
        isOpen={dialogMode === 'reanalyze'}
        onClose={() => setDialogMode(null)}
        projectId={project.id}
      />
    </div>
  );
}
