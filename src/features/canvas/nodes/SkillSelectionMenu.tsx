import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play } from 'lucide-react';
import { UI_POPOVER_TRANSITION_MS } from '@/components/ui/motion';

interface SkillSelectionMenuProps {
  position: { x: number; y: number };
  selectedNodeIds: string[]; // 当前选中的节点ID
  onClose: () => void;
}

export function SkillSelectionMenu({
  position,
  selectedNodeIds,
  onClose,
}: SkillSelectionMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);

  // 定义可用的技能项
  interface SkillItem { id: string; label: string; description: string; icon: typeof Play; action: () => Promise<void>; }
  const skillItems = useMemo<SkillItem[]>(() => [
    // 短视频版技能项在此添加
  ], [selectedNodeIds]);

  useEffect(() => {
    requestAnimationFrame(() => {
      setIsVisible(true);
    });
  }, []);

  const handleClose = useCallback(() => {
    setIsVisible(false);
    setTimeout(onClose, UI_POPOVER_TRANSITION_MS);
  }, [onClose]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) {
        return;
      }

      handleClose();
    };

    document.addEventListener('mousedown', onPointerDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
    };
  }, [handleClose]);

  return (
    <div
      ref={menuRef}
      className={`
        absolute z-50 min-w-[280px] overflow-hidden rounded-lg border border-border-dark bg-surface-dark shadow-xl
        transition-opacity duration-150
        ${isVisible ? 'opacity-100' : 'opacity-0'}
      `}
      style={{ left: position.x, top: position.y }}
    >
      <div className="px-2 py-1 text-xs text-text-secondary font-medium uppercase tracking-wider">
        小鸭技能
      </div>

      {skillItems.map((item, index) => {
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-bg-dark rounded-md m-1"
            style={{ transitionDelay: isVisible ? `${index * 30}ms` : '0ms' }}
            onClick={async () => {
              handleClose();
              await item.action();
            }}
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-accent/10">
              <Icon className="h-4 w-4 text-accent" />
            </div>
            <div className="flex-1 text-left">
              <div className="text-sm text-text-dark font-medium">{item.label}</div>
              <div className="text-xs text-text-secondary">{item.description}</div>
            </div>
            <Play className="h-4 w-4 text-text-secondary" />
          </button>
        );
      })}
    </div>
  );
}