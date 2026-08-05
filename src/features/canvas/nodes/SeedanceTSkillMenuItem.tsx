import { executeSeedanceTSkill, canUseSeedanceTSkill } from '@/features/seedance/SeedanceTSkillExecutor';
import { UiButton } from '@/components/ui/primitives';

/**
 * 用于在画布节点上下文菜单中添加Seedance-T技能选项
 * 这个组件会检查权限并执行技能
 */
export function SeedanceTSkillMenuItem({
  nodeId,
  nodeData
}: {
  nodeId: string;
  nodeData: any;
}) {
  const handleClick = async () => {
    try {
      // 检查技能权限
      const canUse = await canUseSeedanceTSkill();

      if (!canUse) {
        // 如果不能使用技能，会在检查过程中自动提示用户
        return;
      }

      // 获取节点相关信息作为输入
      let input = nodeData?.prompt || nodeData?.title || `处理节点 ${nodeId}`;

      // 执行技能
      const result = await executeSeedanceTSkill(input, {
        frameCount: 9, // 默认9宫格
        aspectRatio: '16:9'
      });

      if (result.success) {
        console.log('Seedance-T技能执行成功:', result.result);
        // 可以在这里更新节点状态或其他UI反馈
      } else {
        console.error('Seedance-T技能执行失败:', result.error);
        alert(result.error || '技能执行失败');
      }
    } catch (error) {
      console.error('执行Seedance-T技能时发生错误:', error);
      alert('执行技能时发生错误，请稍后重试');
    }
  };

  return (
    <button
      onClick={handleClick}
      className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent rounded-md w-full text-left"
      disabled={false}
    >
      <span>🎬</span>
      <span>Seedance-T 分镜</span>
    </button>
  );
}

/**
 * 专用的Seedance-T技能按钮组件
 * 可以直接在UI中使用
 */
export function SeedanceTSkillButton({
  input,
  onSuccess,
  onError,
  children = '生成分镜',
  variant = 'muted'
}: {
  input: string;
  onSuccess?: (result: any) => void;
  onError?: (error: string) => void;
  children?: React.ReactNode;
  variant?: 'primary' | 'muted' | 'ghost';
}) {
  const handleClick = async () => {
    try {
      // 执行技能（权限检查在executeSeedanceTSkill内部完成）
      const result = await executeSeedanceTSkill(input);

      if (result.success) {
        console.log('Seedance-T技能执行成功:', result.result);
        onSuccess?.(result.result);
      } else {
        console.error('Seedance-T技能执行失败:', result.error);
        onError?.(result.error || '技能执行失败');
      }
    } catch (error) {
      console.error('执行Seedance-T技能时发生错误:', error);
      onError?.('执行技能时发生错误，请稍后重试');
    }
  };

  return (
    <UiButton onClick={handleClick} variant={variant}>
      {children}
    </UiButton>
  );
}

export default SeedanceTSkillMenuItem;