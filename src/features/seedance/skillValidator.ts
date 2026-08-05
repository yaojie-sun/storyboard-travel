/**
 * Seedance-T 技能验证器
 * 专为Claude技能调用设计
 * 检查用户登录状态和剩余次数
 */

import { checkSkillPermission } from '@/commands/ai';

/**
 * 验证用户是否可以使用seedance-t技能
 * @returns Promise<{ allowed: boolean; message: string; credits: number }>
 */
export async function validateSeedanceTSkillUsage(): Promise<{ allowed: boolean; message: string; credits: number }> {
  try {
    // 检查技能权限
    const permissionResult = await checkSkillPermission();

    return permissionResult;
  } catch (error) {
    console.error('[Seedance-T Validator] 验证技能使用权限时发生错误:', error);

    return {
      allowed: false,
      message: '无法验证技能使用权限，请检查连接或重新登录',
      credits: 0
    };
  }
}

/**
 * 便捷函数：检查技能是否可用
 * @returns Promise<boolean> - 技能是否可用
 */
export async function isSeedanceTSkillAvailable(): Promise<boolean> {
  const result = await validateSeedanceTSkillUsage();
  return result.allowed;
}

/**
 * 获取用户技能使用状态
 * @returns 用户当前的技能使用状态
 */
export async function getSeedanceTSkillStatus() {
  const result = await validateSeedanceTSkillUsage();

  return {
    canUseSkill: result.allowed,
    message: result.message,
    remainingCredits: result.credits,
    needsRecharge: result.credits <= 0 && result.allowed === false
  };
}