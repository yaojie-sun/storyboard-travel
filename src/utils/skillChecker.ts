import { checkSkillPermission } from '../commands/ai';

/**
 * 检查seedance-t技能是否可以使用
 * 该函数会检查用户登录状态和剩余次数
 */
export async function checkSeedanceTSkillAccess(): Promise<{ canUse: boolean; reason: string; credits: number }> {
  try {
    const result = await checkSkillPermission();

    if (result.allowed) {
      return {
        canUse: true,
        reason: result.message,
        credits: result.credits
      };
    } else {
      return {
        canUse: false,
        reason: result.message,
        credits: result.credits
      };
    }
  } catch (error) {
    console.error('[Seedance-T Skill Checker] 检查技能访问权限失败:', error);
    return {
      canUse: false,
      reason: '无法检查技能访问权限，请稍后重试',
      credits: 0
    };
  }
}

/**
 * 检查技能权限并在不满足条件时显示适当的提示
 * 返回是否允许使用技能
 */
export async function requireSkillPermission(showAlert: boolean = true): Promise<boolean> {
  const checkResult = await checkSeedanceTSkillAccess();

  if (!checkResult.canUse) {
    if (showAlert) {
      alert(checkResult.reason);
    }
    return false;
  }

  return true;
}