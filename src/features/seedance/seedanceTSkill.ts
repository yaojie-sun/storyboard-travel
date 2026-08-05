import { requireSkillPermission } from '@/utils/skillChecker';

/**
 * Seedance-T 技能入口函数
 * 在执行任何分镜生成操作之前，检查用户权限
 */
export async function executeSeedanceTSkill(
  input: string,
  options?: {
    skipPermissionCheck?: boolean,
    onInsufficientCredits?: () => void
  }
): Promise<{ success: boolean; result?: any; error?: string }> {

  // 默认检查权限，除非明确跳过
  if (options?.skipPermissionCheck !== true) {
    const hasPermission = await requireSkillPermission(true);

    if (!hasPermission) {
      if (options?.onInsufficientCredits) {
        options.onInsufficientCredits();
      }
      return {
        success: false,
        error: '用户权限不足，无法执行seedance-t技能'
      };
    }
  }

  try {
    // 这里应该是原来的seedance-t技能逻辑
    // 为了演示目的，我将模拟技能执行过程
    console.log('[Seedance-T Skill] 执行技能，输入:', input);

    // 模拟技能处理过程
    const result = {
      processedInput: input,
      timestamp: new Date().toISOString(),
      message: 'Seedance-T技能执行成功'
    };

    return {
      success: true,
      result: result
    };
  } catch (error) {
    console.error('[Seedance-T Skill] 执行技能失败:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : '技能执行失败'
    };
  }
}

/**
 * 检查当前用户是否可以使用seedance-t技能
 * 这个函数可以在UI组件中用于动态控制界面元素的可见性/可用性
 */
export async function canUseSeedanceTSkill(): Promise<boolean> {
  const result = await requireSkillPermission(false); // 不显示弹窗
  return result;
}