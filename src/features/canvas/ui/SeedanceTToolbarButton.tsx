import { UiButton } from '@/components/ui/primitives';
import { Film } from 'lucide-react';
import { executeSeedanceTSkill, canUseSeedanceTSkill } from '@/features/seedance/SeedanceTSkillExecutor';

interface SeedanceTToolbarButtonProps {
  input?: string;
  onExecute?: (success: boolean, result?: any) => void;
  variant?: 'primary' | 'muted' | 'ghost';
  size?: 'sm' | 'md';
}

export function SeedanceTToolbarButton({
  input = '请提供具体的想法或场景描述',
  onExecute,
  variant = 'muted',
  size = 'md'
}: SeedanceTToolbarButtonProps) {
  const handleClick = async () => {
    try {
      // 检查技能权限
      const hasPermission = await canUseSeedanceTSkill();

      if (!hasPermission) {
        // 权限检查失败会在内部处理提示
        onExecute?.(false);
        return;
      }

      // 执行技能
      const result = await executeSeedanceTSkill(input);

      if (result.success) {
        console.log('Seedance-T技能执行成功:', result.result);
        onExecute?.(true, result.result);
      } else {
        console.error('Seedance-T技能执行失败:', result.error);
        alert(result.error || '技能执行失败');
        onExecute?.(false);
      }
    } catch (error) {
      console.error('执行Seedance-T技能时发生错误:', error);
      alert('执行技能时发生错误，请稍后重试');
      onExecute?.(false);
    }
  };

  return (
    <UiButton
      onClick={handleClick}
      variant={variant}
      size={size}
      title="Seedance-T 分镜技能：将想法转换为专业分镜提示词"
    >
      <Film className="w-4 h-4 mr-2" />
      Seedance-T
    </UiButton>
  );
}

export default SeedanceTToolbarButton;