import { useMemo, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, FolderOpen, Pencil, Trash2, Copy, Loader2 } from 'lucide-react';
import { useProjectStore } from '@/stores/projectStore';
import { useEpisodeStore } from '@/stores/episodeStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { UI_CONTENT_OVERLAY_INSET_CLASS } from '@/components/ui/motion';
import { UiButton, UiSelect, UiModal, UiPanel } from '@/components/ui/primitives';
import { MissingApiKeyHint } from '@/features/settings/MissingApiKeyHint';
import { RenameDialog } from './RenameDialog';
import { ProjectSetupDialog, type ProjectSetupParams } from './ProjectSetupDialog';
import { analyzeStory, type StoryAnalysisResult } from '@/commands/chat';
import { generateProjectGlobalsMd } from '@/commands/projectState';
import { getEmphasisLabels } from './presets';

type ProjectSortField = 'name' | 'createdAt' | 'updatedAt';
type SortDirection = 'asc' | 'desc';

export function ProjectManager() {
  const { t } = useTranslation();
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [editingProjectName, setEditingProjectName] = useState('');
  const [copyingProjectId, setCopyingProjectId] = useState<string | null>(null);
  const [copyingProjectName, setCopyingProjectName] = useState('');
  const [showSetupDialog, setShowSetupDialog] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const [deletingProjectName, setDeletingProjectName] = useState('');
  const [newProjectId, setNewProjectId] = useState<string | null>(null);
  const [showAnalyzing, setShowAnalyzing] = useState(false);
  const [analyzingError, setAnalyzingError] = useState<string | null>(null);
  const [analysisReport, setAnalysisReport] = useState<StoryAnalysisResult | null>(null);
  const [sortField, setSortField] = useState<ProjectSortField>('createdAt');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const configuredApiKeyCount = useSettingsStore((state) => state.getConfiguredApiKeyCount());

  const { projects, isOpeningProject, createProject, deleteProject, renameProject, copyProject, openProject } =
    useProjectStore();
  const { createEpisode } = useEpisodeStore();

  const handleCreateProject = () => {
    setEditingProjectId(null);
    setEditingProjectName('');
    setShowRenameDialog(true);
  };

  const handleCopyClick = (id: string, name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setCopyingProjectId(id);
    setCopyingProjectName(`${name} - 副本`);
    setShowRenameDialog(true);
  };

  const handleRenameClick = (id: string, name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingProjectId(id);
    setEditingProjectName(name);
    setShowRenameDialog(true);
  };

  const handleDeleteClick = (id: string, name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeletingProjectId(id);
    setDeletingProjectName(name);
    setShowDeleteConfirm(true);
  };

  const handleDeleteConfirm = () => {
    if (deletingProjectId) {
      deleteProject(deletingProjectId);
    }
    setShowDeleteConfirm(false);
    setDeletingProjectId(null);
    setDeletingProjectName('');
  };

  const handleConfirm = (name: string) => {
    if (copyingProjectId) {
      void copyProject(copyingProjectId, name);
      setCopyingProjectId(null);
      setCopyingProjectName('');
    } else if (editingProjectId) {
      renameProject(editingProjectId, name);
      setEditingProjectId(null);
    } else {
      // Handle creating: create project then open setup dialog
      const pid = createProject(name);
      setNewProjectId(pid);
      setShowSetupDialog(true);
    }
    setShowRenameDialog(false);
  };

  const handleSetupConfirm = useCallback(
    async (params: ProjectSetupParams) => {
      const pid = newProjectId;
      if (!pid) return;
      setShowSetupDialog(false);
      setAnalyzingError(null);
      setAnalysisReport(null);

      // Save basic params immediately
      useProjectStore.getState().updateProjectParams(pid, {
        videoType: params.videoType,
        aspectRatio: params.aspectRatio,
        style: params.style,
        tone: params.tone,
        directorRef: params.directorRef,
        emphasisKeys: params.emphasisKeys,
      });

      // Only show analyzing if there's a story outline to analyze
      if (!params.storyOutline.trim()) {
        createEpisode(pid, t('episode.defaultName', { number: 1 }));
        openProject(pid);
        return;
      }

      setShowAnalyzing(true);

      try {
        const emphasisLabels = getEmphasisLabels(params.emphasisKeys);
        const analysis = await analyzeStory({
          storyOutline: params.storyOutline,
          aspectRatio: params.aspectRatio,
          style: params.style,
          tone: params.tone,
          directorRef: params.directorRef,
          emphasisDimensions: emphasisLabels,
        });

        // Save analysis results
        const projectName = useProjectStore.getState().currentProject?.name || '';
        useProjectStore.getState().saveProjectAnalysis(pid, {
          aiAnalysis: analysis.analysis_summary,
          aiParams: analysis.raw_json,
        });

        // Generate project_globals.md
        const mdPath = await generateProjectGlobalsMd({
          projectId: pid,
          projectName,
          videoType: params.videoType,
          aspectRatio: params.aspectRatio,
          style: params.style,
          tone: params.tone,
          directorRef: params.directorRef,
          emphasisDimensions: emphasisLabels,
          analysisSummary: analysis.analysis_summary,
          aiParamsJson: analysis.raw_json,
        });

        // Save MD path to project
        useProjectStore.getState().saveProjectAnalysis(pid, {
          globalParamsMdPath: mdPath,
        });

        // Show report dialog
        setShowAnalyzing(false);
        setAnalysisReport(analysis);
      } catch (error) {
        console.error('[ProjectSetup] 分析失败:', error);
        setShowAnalyzing(false);
        setAnalyzingError(error instanceof Error ? error.message : '分析失败，请重试');
        // Let user retry by closing error and going back
      }
    },
    [newProjectId, createEpisode, openProject],
  );

  const handleReportConfirm = () => {
    const pid = newProjectId;
    if (!pid) return;
    setAnalysisReport(null);
    setNewProjectId(null);
    createEpisode(pid, t('episode.defaultName', { number: 1 }));
    openProject(pid);
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString();
  };

  const sortedProjects = useMemo(() => {
    const list = [...projects];
    const direction = sortDirection === 'asc' ? 1 : -1;

    list.sort((a, b) => {
      if (sortField === 'name') {
        return a.name.localeCompare(b.name, 'zh-Hans-CN', { sensitivity: 'base' }) * direction;
      }

      const left = sortField === 'createdAt' ? a.createdAt : a.updatedAt;
      const right = sortField === 'createdAt' ? b.createdAt : b.updatedAt;
      return (left - right) * direction;
    });

    return list;
  }, [projects, sortDirection, sortField]);

  return (
    <div className="ui-scrollbar h-full w-full overflow-auto p-8">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-text-dark">{t('project.title')}</h1>
            <div className="flex items-center gap-2">
              <UiSelect
                aria-label={t('project.sortBy')}
                value={sortField}
                onChange={(event) => setSortField(event.target.value as ProjectSortField)}
                className="h-9 w-[100px] rounded-lg text-sm"
              >
                <option value="name">{t('project.sortByName')}</option>
                <option value="createdAt">{t('project.sortByCreatedAt')}</option>
                <option value="updatedAt">{t('project.sortByUpdatedAt')}</option>
              </UiSelect>
              <UiSelect
                aria-label={t('project.sortDirection')}
                value={sortDirection}
                onChange={(event) => setSortDirection(event.target.value as SortDirection)}
                className="h-9 w-[60px] rounded-lg text-sm"
              >
                <option value="asc">{t('project.sortAsc')}</option>
                <option value="desc">{t('project.sortDesc')}</option>
              </UiSelect>
            </div>
          </div>
          <UiButton type="button" variant="primary" onClick={handleCreateProject} className="gap-2">
            <Plus className="w-5 h-5" />
            {t('project.newProject')}
          </UiButton>
        </div>

        {configuredApiKeyCount === 0 && <MissingApiKeyHint className="mb-8" />}

        {projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-text-muted">
            <FolderOpen className="w-16 h-16 mb-4 opacity-50" />
            <p className="text-lg">{t('project.empty')}</p>
            <p className="text-sm mt-2">{t('project.emptyHint')}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {sortedProjects.map((project) => (
              <div
                key={project.id}
                onClick={() => openProject(project.id)}
                className="bg-surface-dark border border-border-dark rounded-lg p-4 cursor-pointer hover:border-primary/50 hover:shadow-lg transition-all group"
              >
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-semibold text-text-dark truncate flex-1">
                    {project.name}
                  </h3>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      type="button"
                      onClick={(e) => handleCopyClick(project.id, project.name, e)}
                      className="p-1 hover:bg-bg-dark rounded"
                      title={t('project.copy')}
                    >
                      <Copy className="w-4 h-4 text-text-muted hover:text-text-dark" />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => handleRenameClick(project.id, project.name, e)}
                      className="p-1 hover:bg-bg-dark rounded"
                      title={t('project.rename')}
                    >
                      <Pencil className="w-4 h-4 text-text-muted hover:text-text-dark" />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => handleDeleteClick(project.id, project.name, e)}
                      className="p-1 hover:bg-bg-dark rounded"
                      title={t('project.delete')}
                    >
                      <Trash2 className="w-4 h-4 text-text-muted hover:text-red-500" />
                    </button>
                  </div>
                </div>
                <div className="text-xs text-text-muted">
                  <p>
                    {t('project.modified')}: {formatDate(project.updatedAt)}
                  </p>
                  <p>
                    {t('project.created')}: {formatDate(project.createdAt)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {isOpeningProject && (
        <div className={`pointer-events-none fixed ${UI_CONTENT_OVERLAY_INSET_CLASS} bg-black/10`} />
      )}

      <RenameDialog
        isOpen={showRenameDialog}
        title={copyingProjectId ? t('project.copyTitle') : editingProjectId ? t('project.renameTitle') : t('project.newProjectTitle')}
        defaultValue={copyingProjectId ? copyingProjectName : editingProjectName}
        onClose={() => {
          setShowRenameDialog(false);
          setCopyingProjectId(null);
          setCopyingProjectName('');
        }}
        onConfirm={handleConfirm}
      />

      <ProjectSetupDialog
        isOpen={showSetupDialog}
        onClose={() => {
          setShowSetupDialog(false);
          setNewProjectId(null);
        }}
        onConfirm={handleSetupConfirm}
      />

      {/* 删除项目确认弹窗 */}
      {showDeleteConfirm && (
        <div className={`fixed ${UI_CONTENT_OVERLAY_INSET_CLASS} z-50 flex items-center justify-center bg-black/55`}>
          <UiPanel className="flex w-[400px] max-w-[90vw] flex-col gap-5 p-6">
            <div>
              <h3 className="mb-2 text-base font-semibold text-text-dark">
                {t('project.deleteConfirmTitle', '确认删除')}
              </h3>
              <p className="text-sm leading-6 text-text-muted">
                {t('project.deleteConfirmMessage', '确定要删除项目')}「{deletingProjectName}」{t('project.deleteConfirmWarning', '？删除后项目及其所有剧集、节点数据将被永久删除，无法恢复。')}
              </p>
            </div>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => { setShowDeleteConfirm(false); setDeletingProjectId(null); setDeletingProjectName(''); }}
                className="rounded-lg border border-[rgba(255,255,255,0.12)] px-4 py-2 text-sm text-text-muted transition-colors hover:bg-bg-dark"
              >
                {t('common.cancel', '取消')}
              </button>
              <button
                type="button"
                onClick={handleDeleteConfirm}
                className="rounded-lg bg-red-500/80 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-500"
              >
                {t('common.delete', '删除')}
              </button>
            </div>
          </UiPanel>
        </div>
      )}

      {showAnalyzing && (
        <div className={`fixed ${UI_CONTENT_OVERLAY_INSET_CLASS} z-50 flex items-center justify-center bg-black/55`}>
          <UiPanel className="flex flex-col items-center gap-4 px-10 py-8">
            <Loader2 className="h-10 w-10 animate-spin text-accent" />
            <p className="text-base text-text-dark">{t('projectSetup.analyzing')}</p>
          </UiPanel>
        </div>
      )}

      {analysisReport && (
        <UiModal
          isOpen
          title={t('projectSetup.analysisReport')}
          onClose={() => setAnalysisReport(null)}
          widthClassName="w-[640px]"
          footer={
            <UiButton type="button" variant="primary" onClick={handleReportConfirm}>
              {t('projectSetup.enterDashboard')}
            </UiButton>
          }
        >
          <div className="max-h-[60vh] space-y-3 overflow-y-auto ui-scrollbar text-sm">
            <div>
              <span className="font-semibold text-text-dark">{t('projectSetup.logline')}：</span>
              <span className="text-text-muted">{analysisReport.logline}</span>
            </div>
            <div>
              <span className="font-semibold text-text-dark">{t('projectSetup.genre')}：</span>
              <span className="text-text-muted">{analysisReport.genre}</span>
            </div>
            {analysisReport.themes.length > 0 && (
              <div>
                <span className="font-semibold text-text-dark">{t('projectSetup.themes')}：</span>
                <span className="text-text-muted">{analysisReport.themes.join('、')}</span>
              </div>
            )}
            {analysisReport.characters.length > 0 && (
              <div>
                <span className="font-semibold text-text-dark">{t('projectSetup.characters')}：</span>
                <div className="mt-1 space-y-1">
                  {analysisReport.characters.map((c, i) => (
                    <div key={i} className="pl-4 text-text-muted">
                      · {c.name}（{c.archetype}）— {c.arc}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div>
              <span className="font-semibold text-text-dark">{t('projectSetup.visualStyle')}：</span>
              <div className="pl-4 text-text-muted">
                <div>{analysisReport.visual_style.color_palette}</div>
                <div>{analysisReport.visual_style.lighting}</div>
                <div>{analysisReport.visual_style.camera}</div>
              </div>
            </div>
            <div>
              <span className="font-semibold text-text-dark">{t('projectSetup.pacing')}：</span>
              <span className="text-text-muted">{analysisReport.pacing}</span>
            </div>
            <div>
              <span className="font-semibold text-text-dark">{t('projectSetup.summary')}：</span>
              <p className="mt-1 whitespace-pre-wrap text-text-muted">{analysisReport.analysis_summary}</p>
            </div>
          </div>
        </UiModal>
      )}

      {analyzingError && (
        <UiModal
          isOpen
          title={t('projectSetup.analysisFailed')}
          onClose={() => setAnalyzingError(null)}
          widthClassName="w-[400px]"
          footer={
            <>
              <UiButton type="button" variant="ghost" onClick={() => setAnalyzingError(null)}>
                {t('common.cancel')}
              </UiButton>
              <UiButton type="button" variant="primary" onClick={() => { setAnalyzingError(null); setShowSetupDialog(true); }}>
                {t('projectSetup.retry')}
              </UiButton>
            </>
          }
        >
          <p className="text-sm text-text-muted">{analyzingError}</p>
        </UiModal>
      )}
    </div>
  );
}
