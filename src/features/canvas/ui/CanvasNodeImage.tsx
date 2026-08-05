import { memo, useCallback, useEffect, useRef, useState, type ImgHTMLAttributes, type MouseEvent } from 'react';
import { isTauri } from '@tauri-apps/api/core';

import { loadImage } from '@/commands/image';
import { useCanvasStore } from '@/stores/canvasStore';

export interface CanvasNodeImageProps extends ImgHTMLAttributes<HTMLImageElement> {
  viewerSourceUrl?: string | null;
  viewerImageList?: Array<string | null | undefined>;
  disableViewer?: boolean;
}

function normalizeViewerList(
  imageList: Array<string | null | undefined> | undefined,
  currentImageUrl: string
): string[] {
  const deduped: string[] = [];
  for (const rawItem of imageList ?? []) {
    const item = typeof rawItem === 'string' ? rawItem.trim() : '';
    if (!item || deduped.includes(item)) {
      continue;
    }
    deduped.push(item);
  }

  if (!deduped.includes(currentImageUrl)) {
    deduped.unshift(currentImageUrl);
  }

  return deduped.length > 0 ? deduped : [currentImageUrl];
}

export const CanvasNodeImage = memo(({
  viewerSourceUrl,
  viewerImageList,
  disableViewer = false,
  onDoubleClick,
  src,
  ...props
}: CanvasNodeImageProps) => {
  const openImageViewer = useCanvasStore((state) => state.openImageViewer);
  const [fallbackDataUrl, setFallbackDataUrl] = useState<string | null>(null);
  const fallbackAttemptedRef = useRef(false);

  // src 变化时重置回退状态，重新尝试 asset protocol
  useEffect(() => {
    fallbackAttemptedRef.current = false;
    setFallbackDataUrl(null);
  }, [src]);

  const handleError = useCallback(async () => {
    if (!isTauri() || fallbackAttemptedRef.current || !src) {
      return;
    }

    // 仅当 src 是 asset protocol URL 且尚未尝试回退时
    if (src.startsWith('http://asset.localhost/')) {
      fallbackAttemptedRef.current = true;
      try {
        // 从 asset URL 解码出文件路径
        // http://asset.localhost/C%3A/path/to/file.png 或 http://asset.localhost/C:/path/to/file.png
        const assetPrefix = 'http://asset.localhost/';
        const encodedPath = src.slice(assetPrefix.length);
        const filePath = decodeURIComponent(encodedPath);
        // Windows: decodeURIComponent 会把 %2F 解码为 /，但 std::fs::read 在 Windows 上不认正斜杠
        const windowsPath = /^[A-Za-z]:\//.test(filePath)
          ? filePath.replace(/\//g, '\\')
          : filePath;
        const dataUrl = await loadImage(windowsPath);
        setFallbackDataUrl(dataUrl);
      } catch (err) {
        console.warn('[CanvasNodeImage] asset protocol fallback failed:', err);
      }
    }
  }, [src]);

  const handleDoubleClick = useCallback((event: MouseEvent<HTMLImageElement>) => {
    onDoubleClick?.(event);

    if (event.defaultPrevented || disableViewer) {
      return;
    }

    const fallbackSrc = event.currentTarget.currentSrc || (typeof src === 'string' ? src : '');
    const resolvedSource =
      typeof viewerSourceUrl === 'string' && viewerSourceUrl.trim().length > 0
        ? viewerSourceUrl.trim()
        : fallbackSrc.trim();
    if (!resolvedSource) {
      return;
    }

    event.stopPropagation();
    openImageViewer(resolvedSource, normalizeViewerList(viewerImageList, resolvedSource));
  }, [disableViewer, onDoubleClick, openImageViewer, src, viewerImageList, viewerSourceUrl]);

  return (
    <img
      {...props}
      src={fallbackDataUrl ?? src}
      data-viewer-src={
        typeof viewerSourceUrl === 'string' && viewerSourceUrl.trim().length > 0
          ? viewerSourceUrl.trim()
          : undefined
      }
      onError={handleError}
      onDoubleClick={handleDoubleClick}
    />
  );
});

CanvasNodeImage.displayName = 'CanvasNodeImage';
