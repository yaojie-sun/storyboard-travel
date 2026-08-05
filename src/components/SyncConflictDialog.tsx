import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

export interface ProjectNameConflict {
  name: string;
  local_id: string;
  cloud_id: string;
  local_updated_at: number;
  cloud_updated_at: number;
  local_node_count: number;
  cloud_node_count: number;
}

export interface ConflictChoice {
  cloudId: string;
  action: 'overwrite' | 'keep_local';
}

interface SyncConflictDialogProps {
  isOpen: boolean;
  conflicts: ProjectNameConflict[];
  onConfirm: (choices: ConflictChoice[]) => void;
  onCancel: () => void;
}

function formatTime(ts: number): string {
  if (!ts) return '-';
  return new Date(ts * 1000).toLocaleString();
}

export function SyncConflictDialog({
  isOpen,
  conflicts,
  onConfirm,
  onCancel,
}: SyncConflictDialogProps) {
  const { t } = useTranslation();
  const [choices, setChoices] = useState<Record<string, 'overwrite' | 'keep_local'>>({});

  if (!isOpen || conflicts.length === 0) return null;

  const allDecided = conflicts.every((c) => choices[c.cloud_id]);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50">
      <div className="w-full max-w-lg rounded-lg border border-border bg-surface p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text">
            {t('sync.conflictTitle', '检测到项目名称冲突')}
          </h2>
          <button
            onClick={onCancel}
            className="rounded p-1 text-text-muted hover:bg-surface-dark hover:text-text"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <p className="mb-4 text-sm text-text-muted">
          {t(
            'sync.conflictDesc',
            '云端与本地存在同名项目，请逐项选择保留本地数据还是用云端数据覆盖：'
          )}
        </p>

        <div className="max-h-64 space-y-3 overflow-y-auto">
          {conflicts.map((c) => (
            <div
              key={c.cloud_id}
              className="rounded border border-border bg-bg-dark p-3"
            >
              <div className="mb-1 font-medium text-text">{c.name}</div>
              <div className="mb-2 text-xs text-text-muted">
                <div>
                  {t('sync.localInfo', '本地')}: {c.local_node_count}{' '}
                  {t('sync.nodes', '节点')} ·{' '}
                  {formatTime(c.local_updated_at)}
                </div>
                <div>
                  {t('sync.cloudInfo', '云端')}: {c.cloud_node_count}{' '}
                  {t('sync.nodes', '节点')} ·{' '}
                  {formatTime(c.cloud_updated_at)}
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() =>
                    setChoices((prev) => ({
                      ...prev,
                      [c.cloud_id]: 'keep_local',
                    }))
                  }
                  className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                    choices[c.cloud_id] === 'keep_local'
                      ? 'bg-accent/20 text-accent ring-1 ring-accent'
                      : 'bg-surface-dark text-text-muted hover:bg-surface'
                  }`}
                >
                  {t('sync.keepLocal', '保留本地')}
                </button>
                <button
                  onClick={() =>
                    setChoices((prev) => ({
                      ...prev,
                      [c.cloud_id]: 'overwrite',
                    }))
                  }
                  className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                    choices[c.cloud_id] === 'overwrite'
                      ? 'bg-orange-500/20 text-orange-400 ring-1 ring-orange-500'
                      : 'bg-surface-dark text-text-muted hover:bg-surface'
                  }`}
                >
                  {t('sync.overwrite', '用云端覆盖')}
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded px-4 py-2 text-sm text-text-muted hover:text-text"
          >
            {t('common.cancel', '取消')}
          </button>
          <button
            onClick={() => {
              const result = conflicts.map((c) => ({
                cloudId: c.cloud_id,
                action: choices[c.cloud_id] || 'keep_local',
              }));
              onConfirm(result);
            }}
            disabled={!allDecided}
            className="rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
          >
            {t('sync.confirmMerge', '确认合并')}
          </button>
        </div>
      </div>
    </div>
  );
}
