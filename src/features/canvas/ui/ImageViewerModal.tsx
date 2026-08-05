import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri } from '@tauri-apps/api/core';
import { ChevronLeft, ChevronRight, RotateCcw, X } from 'lucide-react';
import { UI_CONTENT_OVERLAY_INSET_CLASS } from '@/components/ui/motion';
import { loadImage } from '@/commands/image';
import { useImageViewerTransform } from '../hooks/useImageViewerTransform';

export interface ImageViewerModalProps {
  open: boolean;
  imageUrl: string;
  imageList: string[];
  currentIndex: number;
  onClose: () => void;
  onNavigate: (direction: 'prev' | 'next') => void;
}

export function ImageViewerModal({
  open,
  imageUrl,
  imageList,
  currentIndex,
  onClose,
  onNavigate,
}: ImageViewerModalProps): JSX.Element | null {
  const { t } = useTranslation();
  const viewerControlClass =
    'inline-flex h-10 items-center justify-center rounded-full border border-white/20 bg-black/60 px-4 text-sm text-white backdrop-blur-xl';
  const [isVisible, setIsVisible] = useState(false);
  const [overlayOpacity, setOverlayOpacity] = useState(0);
  const [displayImageUrl, setDisplayImageUrl] = useState(imageUrl);
  const [imgError, setImgError] = useState(false);
  const [isLoadingDataUrl, setIsLoadingDataUrl] = useState(false);
  const closeTimerRef = useRef<number | null>(null);

  const {
    containerRef,
    imageRef,
    scaleDisplayRef,
    viewerOpacity,
    resetView,
    handleImageMouseDown,
    handleContainerMouseMove,
    handleContainerMouseUp,
    handleImageMouseMove,
    handleImageLoad,
    isPointOnImageContent,
  } = useImageViewerTransform(open && isVisible);

  useEffect(() => {
    if (!isVisible) return;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, [isVisible]);

  useEffect(() => {
    if (open) {
      setDisplayImageUrl(imageUrl);
      setIsVisible(true);
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      setOverlayOpacity(0);
      requestAnimationFrame(() => {
        setOverlayOpacity(1);
      });
      return;
    }
    if (!isVisible) return;
    setOverlayOpacity(0);
    closeTimerRef.current = window.setTimeout(() => {
      setIsVisible(false);
      setDisplayImageUrl('');
    }, 400);
    return () => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
  }, [open, isVisible]);

  useEffect(() => {
    if (!open || !imageUrl) {
      return;
    }
    setDisplayImageUrl(imageUrl);
    setImgError(false);
  }, [open, imageUrl]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    resetView();
  }, [open, imageUrl, resetView]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        onNavigate('prev');
      } else if (e.key === 'ArrowRight') {
        onNavigate('next');
      } else if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onNavigate, onClose]);

  const handleImageError = useCallback(async () => {
    console.warn('[ImageViewer] 图片加载失败:', displayImageUrl);
    if (!isTauri() || !displayImageUrl || displayImageUrl.startsWith('data:')) {
      setImgError(true);
      return;
    }

    setIsLoadingDataUrl(true);
    try {
      let filePath = displayImageUrl;
      const assetPrefix = 'http://asset.localhost/';
      if (filePath.startsWith(assetPrefix)) {
        filePath = decodeURIComponent(filePath.slice(assetPrefix.length));
        // Windows: decodeURIComponent 会把 %2F 解码为 /，但 std::fs::read 在 Windows 上不认正斜杠
        if (/^[A-Za-z]:\//.test(filePath)) {
          filePath = filePath.replace(/\//g, '\\');
        }
        console.warn('[ImageViewer] decoded fallback path:', filePath);
      } else if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
        setImgError(true);
        return;
      }

      const dataUrl = await loadImage(filePath);
      setDisplayImageUrl(dataUrl);
      setImgError(false);
      console.info('[ImageViewer] data URL fallback succeeded');
    } catch (err) {
      console.error('[ImageViewer] data URL fallback also failed:', err);
      setImgError(true);
    } finally {
      setIsLoadingDataUrl(false);
    }
  }, [displayImageUrl]);

  if (!isVisible) return null;

  return (
    <div
      className={`fixed ${UI_CONTENT_OVERLAY_INSET_CLASS} z-[100] overflow-hidden bg-black/90 backdrop-blur-lg`}
      style={{
        opacity: overlayOpacity,
        transition: 'opacity 400ms ease',
        pointerEvents: open ? 'auto' : 'none',
      }}
    >
      {/* 顶栏 — 视觉上明确这是覆盖层并提供明显的关闭入口 */}
      <div className="absolute top-0 inset-x-0 h-10 flex items-center justify-between px-4 bg-black/60 backdrop-blur-md border-b border-white/10 select-none">
        <span className="text-sm text-white/80">
          {t('viewer.title', '图片查看器')}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center gap-1.5 rounded-lg bg-white/10 hover:bg-white/20 border border-white/15 px-3 py-1.5 text-sm text-white transition-colors"
          title={t('common.close', '关闭')}
        >
          <X className="h-3.5 w-3.5" />
          <span>{t('common.close', '关闭')}</span>
        </button>
      </div>

      <div
        ref={containerRef}
        className="absolute inset-0 top-10 flex items-center justify-center overflow-hidden p-4"
        style={{ overscrollBehavior: 'contain' }}
        onMouseMove={handleContainerMouseMove}
        onMouseUp={handleContainerMouseUp}
        onMouseLeave={handleContainerMouseUp}
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className="relative">
          {displayImageUrl && !imgError ? (
            <img
              key={displayImageUrl}
              ref={imageRef}
              src={displayImageUrl}
              alt={t('viewer.imageAlt', '图片')}
              className="select-none transition-opacity duration-300"
              style={{
                opacity: viewerOpacity * overlayOpacity,
                transformOrigin: 'center',
                width: '95vw',
                height: '95vh',
                objectFit: 'contain',
              }}
              onLoad={(e) => {
                setImgError(false);
                handleImageLoad(e);
              }}
              onError={handleImageError}
              onMouseDown={handleImageMouseDown}
              onMouseMove={handleImageMouseMove}
              onClick={(e) => {
                if (isPointOnImageContent(e.clientX, e.clientY)) {
                  e.stopPropagation();
                } else {
                  onClose();
                }
              }}
              draggable={false}
            />
          ) : (
            <div
              className="flex items-center justify-center"
              style={{ width: '95vw', height: '95vh' }}
            >
              <span className="text-white/40 text-sm">
                {imgError
                  ? t('viewer.loadFailed', '图片加载失败')
                  : isLoadingDataUrl
                  ? t('viewer.fallbackLoading', '尝试加载...')
                  : t('viewer.loading', '加载中...')}
              </span>
            </div>
          )}
        </div>

        <div className="absolute bottom-8 left-1/2 flex -translate-x-1/2 flex-col items-center gap-3">
          {imageList.length > 1 && (
            <div className="flex items-center gap-3">
              <button
                onClick={() => onNavigate('prev')}
                disabled={currentIndex <= 0}
                className="rounded-full bg-zinc-800/80 p-2 text-white backdrop-blur-sm transition-all duration-200 hover:bg-zinc-700/80 disabled:cursor-not-allowed disabled:opacity-50"
                title={t('viewer.prev', '上一张')}
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
              <button
                onClick={() => onNavigate('next')}
                disabled={currentIndex >= imageList.length - 1}
                className="rounded-full bg-zinc-800/80 p-2 text-white backdrop-blur-sm transition-all duration-200 hover:bg-zinc-700/80 disabled:cursor-not-allowed disabled:opacity-50"
                title={t('viewer.next', '下一张')}
              >
                <ChevronRight className="h-5 w-5" />
              </button>
            </div>
          )}

          <div className="flex items-center gap-4">
            {imageList.length > 1 && (
              <div className={viewerControlClass}>
                {currentIndex + 1} / {imageList.length}
              </div>
            )}
            <div
              ref={scaleDisplayRef}
              className={`${viewerControlClass} min-w-[74px]`}
            >
              100%
            </div>
            <button
              onClick={resetView}
              className={`${viewerControlClass} transition-colors hover:bg-white/10`}
              title={t('viewer.reset', '重置视图')}
            >
              <RotateCcw className="h-4 w-4" />
            </button>
            <button
              onClick={onClose}
              className={`${viewerControlClass} transition-colors hover:bg-white/10`}
              title={t('common.close', '关闭')}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
