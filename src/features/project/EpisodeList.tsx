import { useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Pencil, Trash2, Play } from 'lucide-react';
import { useEpisodeStore, type Episode } from '@/stores/episodeStore';
import { UiButton } from '@/components/ui/primitives';
import { RenameDialog } from './RenameDialog';

interface EpisodeListProps {
  projectId: string;
  selectedEpisodeId: string | null;
  onSelectEpisode: (episodeId: string) => void;
  onEnterCanvas: (episodeId: string) => void;
}

export function EpisodeList({ projectId, selectedEpisodeId, onSelectEpisode, onEnterCanvas }: EpisodeListProps) {
  const { t } = useTranslation();
  const emptyRef = useRef<Episode[]>([]);
  const episodes = useEpisodeStore(useCallback((state) => {
    const eps = state.episodesByProject[projectId];
    return eps ?? (emptyRef.current as Episode[]);
  }, [projectId]));
  const { createEpisode, renameEpisode, deleteEpisode } = useEpisodeStore();
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [editingEpisodeId, setEditingEpisodeId] = useState<string | null>(null);
  const [editingEpisodeName, setEditingEpisodeName] = useState('');

  const handleCreate = () => {
    const count = episodes.length + 1;
    createEpisode(projectId, t('episode.defaultName', { number: count }));
  };

  const handleRenameClick = (id: string, name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingEpisodeId(id);
    setEditingEpisodeName(name);
    setShowRenameDialog(true);
  };

  const handleDeleteClick = (id: string) => {
    if (episodes.length <= 1) return;
    deleteEpisode(projectId, id);
  };

  const handleRenameConfirm = (name: string) => {
    if (editingEpisodeId) {
      renameEpisode(projectId, editingEpisodeId, name);
      setEditingEpisodeId(null);
      setEditingEpisodeName('');
      setShowRenameDialog(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-text-dark">{t('episode.title')}</h3>
        <UiButton type="button" variant="primary" size="sm" onClick={handleCreate} className="gap-1.5">
          <Plus className="w-3.5 h-3.5" />
          {t('episode.newEpisode')}
        </UiButton>
      </div>

      {episodes.length === 0 ? (
        <div className="text-sm text-text-muted py-8 text-center">
          {t('episode.empty')}
        </div>
      ) : (
        <div className="space-y-1">
          {episodes
            .slice()
            .sort((a, b) => a.number - b.number)
            .map((episode) => (
              <div
                key={episode.id}
                onClick={() => onSelectEpisode(episode.id)}
                className={`group flex items-center justify-between px-3 py-2.5 rounded-lg cursor-pointer transition-colors ${
                  selectedEpisodeId === episode.id
                    ? 'bg-accent/15 border border-accent/30'
                    : 'hover:bg-bg-dark/60 border border-transparent'
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-xs text-text-muted w-5 text-right shrink-0">
                    {episode.number}
                  </span>
                  <span className="text-sm text-text-dark truncate">{episode.name}</span>
                </div>

                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  <button
                    type="button"
                    onClick={() => onEnterCanvas(episode.id)}
                    className="p-1.5 hover:bg-accent/20 rounded-md text-text-muted hover:text-accent transition-colors"
                    title={t('episode.enterCanvas')}
                  >
                    <Play className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => handleRenameClick(episode.id, episode.name, e)}
                    className="p-1.5 hover:bg-bg-dark rounded-md text-text-muted hover:text-text-dark transition-colors"
                    title={t('common.edit')}
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  {episodes.length > 1 && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); handleDeleteClick(episode.id); }}
                      className="p-1.5 hover:bg-bg-dark rounded-md text-text-muted hover:text-red-500 transition-colors"
                      title={t('common.delete')}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            ))}
        </div>
      )}

      <RenameDialog
        isOpen={showRenameDialog}
        title={t('episode.renameTitle')}
        defaultValue={editingEpisodeName}
        onClose={() => {
          setShowRenameDialog(false);
          setEditingEpisodeId(null);
          setEditingEpisodeName('');
        }}
        onConfirm={handleRenameConfirm}
      />
    </div>
  );
}
