import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { useAssetStore, type AssetRecord } from '@/stores/assetStore';

interface MatchResult {
  name: string;
  category: string;
  matched: boolean;
  asset?: AssetRecord;
}

interface AutoMatchDialogProps {
  isOpen: boolean;
  prompt: string;
  projectId: string;
  onConfirm: (results: MatchResult[]) => void;
  onSkip: () => void;
  onCancel: () => void;
}

export function AutoMatchDialog({
  isOpen,
  prompt,
  projectId,
  onConfirm,
  onSkip,
  onCancel,
}: AutoMatchDialogProps) {
  const { t } = useTranslation();
  const getAssets = useAssetStore((s) => s.getAssets);
  const [step, setStep] = useState<'ask' | 'scanning' | 'results'>('ask');
  const [results, setResults] = useState<MatchResult[]>([]);
  const [matchedCount, setMatchedCount] = useState(0);

  useEffect(() => {
    if (isOpen) {
      setStep('ask');
      setResults([]);
      setMatchedCount(0);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleStartMatch = () => {
    setStep('scanning');

    // Get all assets for the project and check which names appear in the prompt
    const allAssets = getAssets(projectId);
    const matchResults: MatchResult[] = allAssets
      .filter((asset) => prompt.includes(asset.name))
      .map((asset) => ({
        name: asset.name,
        category: asset.category,
        matched: true,
        asset,
      }));

    setResults(matchResults);
    setMatchedCount(matchResults.filter((r) => r.matched).length);

    // Small delay to show scanning state
    setTimeout(() => {
      setStep('results');
    }, 500);
  };

  const handleConfirm = () => {
    onConfirm(results);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div
        className="bg-surface-dark border border-border-dark rounded-xl shadow-xl w-full max-w-md mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {step === 'ask' && (
          <>
            <div className="px-5 py-4 border-b border-border-dark">
              <h2 className="text-base font-semibold text-text-dark">{t('chat.autoMatchTitle')}</h2>
            </div>
            <div className="p-5">
              <p className="text-sm text-text-muted">{t('chat.autoMatchDesc')}</p>
            </div>
            <div className="flex justify-end gap-2 px-5 py-3 border-t border-border-dark">
              <button
                type="button"
                onClick={onCancel}
                className="px-3 py-1.5 text-sm rounded-lg text-text-muted hover:text-text-dark transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={onSkip}
                className="px-3 py-1.5 text-sm rounded-lg border border-border-dark text-text-muted hover:text-text-dark transition-colors"
              >
                {t('chat.autoMatchSkip')}
              </button>
              <button
                type="button"
                onClick={handleStartMatch}
                className="px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:opacity-90 transition-opacity"
              >
                {t('chat.autoMatchStart')}
              </button>
            </div>
          </>
        )}

        {step === 'scanning' && (
          <div className="flex flex-col items-center justify-center py-12">
            <Loader2 className="w-8 h-8 text-accent animate-spin mb-3" />
            <p className="text-sm text-text-muted">{t('chat.autoMatchScanning')}</p>
          </div>
        )}

        {step === 'results' && (
          <>
            <div className="px-5 py-4 border-b border-border-dark">
              <h2 className="text-base font-semibold text-text-dark">{t('chat.autoMatchResults')}</h2>
            </div>
            <div className="p-5 max-h-64 overflow-y-auto">
              {/* Summary */}
              <div className="flex gap-4 mb-4">
                {matchedCount > 0 && (
                  <div className="flex items-center gap-1.5 text-sm">
                    <CheckCircle className="w-4 h-4 text-green-500" />
                    <span className="text-text-muted">{t('chat.autoMatchMatched', { count: matchedCount })}</span>
                  </div>
                )}
                {matchedCount === 0 && (
                  <div className="flex items-center gap-1.5 text-sm">
                    <XCircle className="w-4 h-4 text-warning" />
                    <span className="text-text-muted">{t('chat.autoMatchNotFound')}</span>
                  </div>
                )}
              </div>

              {/* Results list */}
              {results.length > 0 ? (
                <div className="space-y-1.5">
                  {results.map((r, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm">
                      <CheckCircle className="w-3.5 h-3.5 text-green-500 shrink-0" />
                      <span className="text-text-dark">{r.name}</span>
                      {r.asset && (
                        <span className="text-xs text-text-muted">
                          ({t(`asset.category.${r.asset.category}` as any)})
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-3 text-sm text-text-muted">{t('chat.autoMatchNoAssets')}</div>
              )}

              {/* Hint when no assets exist */}
              {results.length === 0 && (
                <div className="mt-4 p-3 bg-warning/10 border border-warning/20 rounded-lg">
                  <p className="text-xs text-warning">{t('chat.autoMatchMissingHint')}</p>
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 px-5 py-3 border-t border-border-dark">
              <button
                type="button"
                onClick={onCancel}
                className="px-3 py-1.5 text-sm rounded-lg text-text-muted hover:text-text-dark transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                className="px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:opacity-90 transition-opacity"
              >
                {t('chat.autoMatchContinue')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
