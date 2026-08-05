import { checkSkillAccess } from '../../utils/skillAccessHelper';
import { bananaGetCurrentUser, isBananaLoggedIn } from '../../commands/ai';

/**
 * Seedance-T 技能执行器
 * 该技能用于将任何想法转换成即梦 Seedance 2.0 专业分镜提示词
 * 支持智能9宫格分镜可视化
 */
export class SeedanceTSkillExecutor {

  /**
   * 检查技能使用权限
   * @returns boolean - 是否允许使用技能
   */
  static async checkPermission(): Promise<boolean> {
    // 检查技能访问权限
    const hasAccess = await checkSkillAccess();

    if (!hasAccess) {
      return false;
    }

    try {
      // 再次检查登录状态和剩余次数
      const isLoggedIn = await isBananaLoggedIn();

      if (!isLoggedIn) {
        console.warn('[Seedance-T Skill] 用户未登录');
        return false;
      }

      // 获取用户信息检查次数
      const userInfo = await bananaGetCurrentUser();

      if (userInfo.credits <= 0) {
        console.warn('[Seedance-T Skill] 用户剩余次数不足', userInfo.credits);
        return false;
      }

      console.log('[Seedance-T Skill] 权限检查通过，用户剩余次数:', userInfo.credits);
      return true;
    } catch (error) {
      console.error('[Seedance-T Skill] 检查权限时发生错误:', error);
      return false;
    }
  }

  /**
   * 执行Seedance-T技能
   * @param input - 用户输入的创意想法
   * @param options - 执行选项
   * @returns 技能执行结果
   */
  static async execute(
    input: string,
    options?: {
      frameCount?: number;
      aspectRatio?: string;
      style?: string;
      skipPermissionCheck?: boolean;
    }
  ): Promise<{
    success: boolean;
    result?: any;
    error?: string;
    creditsRemaining?: number;
  }> {
    // 默认情况下检查权限
    if (options?.skipPermissionCheck !== true) {
      const hasPermission = await this.checkPermission();

      if (!hasPermission) {
        return {
          success: false,
          error: '您的剩余次数为0，请充值后继续使用！费用包含分镜大师和小鸭分镜模型的总和费用!',
          creditsRemaining: 0
        };
      }
    }

    try {
      console.log('[Seedance-T Skill] 开始执行技能，输入:', input);

      // 这里应该是实际的技能处理逻辑
      // 模拟种子技能处理过程
      const result = await this.processSeedance(input, options);

      // 获取当前剩余次数
      let creditsRemaining = 0;
      try {
        const userInfo = await bananaGetCurrentUser();
        creditsRemaining = userInfo.credits;
      } catch (error) {
        console.warn('[Seedance-T Skill] 获取剩余次数失败:', error);
      }

      return {
        success: true,
        result: result,
        creditsRemaining: creditsRemaining
      };
    } catch (error) {
      console.error('[Seedance-T Skill] 执行技能失败:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : '技能执行失败',
        creditsRemaining: 0
      };
    }
  }

  /**
   * 处理Seedance技能的核心逻辑
   * @param input - 用户输入
   * @param options - 处理选项
   * @returns 处理结果
   */
  private static async processSeedance(
    input: string,
    options?: {
      frameCount?: number;
      aspectRatio?: string;
      style?: string;
    }
  ): Promise<any> {
    // 这里应该实现真实的Seedance-T技能逻辑
    // 目前是一个模拟实现

    // 模拟处理延迟
    await new Promise(resolve => setTimeout(resolve, 500));

    return {
      success: true,
      message: `已将您的想法 "${input}" 转换为专业的分镜提示词`,
      frames: options?.frameCount || 9, // 默认9宫格
      aspectRatio: options?.aspectRatio || '16:9',
      style: options?.style || 'cinematic',
      timestamp: new Date().toISOString(),
      visualization: '9-grid-storyboard',
      seedancePrompt: `[SEEDANCE_PROMPT] ${input}`
    };
  }

  /**
   * 获取当前用户信息
   */
  static async getCurrentUserInfo() {
    try {
      const userInfo = await bananaGetCurrentUser();
      return {
        isLoggedIn: true,
        userInfo: userInfo,
        canUseSkill: userInfo.credits > 0
      };
    } catch (error) {
      return {
        isLoggedIn: false,
        userInfo: null,
        canUseSkill: false
      };
    }
  }
}

/**
 * 便捷函数：执行Seedance-T技能
 */
export async function executeSeedanceTSkill(
  input: string,
  options?: {
    frameCount?: number;
    aspectRatio?: string;
    style?: string;
    skipPermissionCheck?: boolean;
  }
) {
  return await SeedanceTSkillExecutor.execute(input, options);
}

/**
 * 便捷函数：检查技能权限
 */
export async function canUseSeedanceTSkill(): Promise<boolean> {
  return await SeedanceTSkillExecutor.checkPermission();
}