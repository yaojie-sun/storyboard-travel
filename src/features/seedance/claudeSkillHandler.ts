/**
 * Seedance-T Claude技能前端处理器
 * 为Claude技能调用提供前端验证和处理接口
 */

import {
  isSeedanceTSkillAvailable,
  validateSeedanceTSkillUsage,
  getSeedanceTSkillStatus
} from './skillValidator';
import { checkAndPerformSkillUpdate } from './skillUpdateManager';

/**
 * Claude调用的Seedance-T技能入口
 * @param input - Claude传入的输入参数
 * @returns 技能处理结果
 */
export async function claudeSeedanceTSkillHandler(input: any): Promise<{
  success: boolean;
  result?: any;
  error?: string;
  creditsRemaining?: number;
}> {
  try {
    // 首先验证技能使用权限
    const validationResult = await validateSeedanceTSkillUsage();

    if (!validationResult.allowed) {
      return {
        success: false,
        error: validationResult.message,
        creditsRemaining: validationResult.credits
      };
    }

    // 处理技能请求
    const processingResult = await processSeedanceTRequest(input);

    // 获取最新的信用余额
    let currentCredits = 0;
    try {
      const status = await getSeedanceTSkillStatus();
      currentCredits = status.remainingCredits;
    } catch (error) {
      console.warn('无法获取最新的信用余额:', error);
    }

    return {
      success: true,
      result: processingResult,
      creditsRemaining: currentCredits
    };
  } catch (error) {
    console.error('[Claude Seedance-T Handler] 处理技能请求失败:', error);

    return {
      success: false,
      error: error instanceof Error ? error.message : '技能处理失败',
      creditsRemaining: 0
    };
  }
}

/**
 * 初始化Seedance-T技能处理器
 * 包括检查更新和验证安全机制
 */
export async function initializeSeedanceTSkill(): Promise<boolean> {
  try {
    console.log('[Seedance-T] 初始化技能处理器...');

    // 检查并执行可能的技能更新
    const updateResult = await checkAndPerformSkillUpdate();

    if (updateResult) {
      console.log('[Seedance-T] 技能更新检查完成');
    } else {
      console.log('[Seedance-T] 无可用更新或用户拒绝更新');
    }

    // 验证安全机制是否就绪
    const isAvailable = await isSeedanceTSkillAvailable();

    if (!isAvailable) {
      console.warn('[Seedance-T] 技能当前不可用（可能是由于权限问题）');
    } else {
      console.log('[Seedance-T] 技能验证通过，可以使用');
    }

    return isAvailable;
  } catch (error) {
    console.error('[Seedance-T] 初始化技能处理器失败:', error);
    return false;
  }
}

/**
 * 获取最近的更新信息
 * 用于向用户展示技能的最新更新内容
 */
export async function getLatestUpdateInfo(): Promise<{
  hasUpdates: boolean;
  version?: string;
  notes?: string;
  updatedAt?: string;
}> {
  try {
    const updateInfo = await import('./skillUpdater').then(module => module.checkForSkillUpdates());

    if (updateInfo) {
      return {
        hasUpdates: true,
        version: updateInfo.version,
        notes: updateInfo.updateNotes,
        updatedAt: updateInfo.updatedAt
      };
    }

    return {
      hasUpdates: false
    };
  } catch (error) {
    console.error('[Seedance-T] 获取更新信息失败:', error);
    return {
      hasUpdates: false
    };
  }
}

/**
 * 处理Seedance-T技能请求的实际逻辑
 * @param input - 输入参数
 * @returns 处理结果
 */
async function processSeedanceTRequest(input: any): Promise<any> {
  // 这里是真实的技能处理逻辑
  // 目前为模拟实现，实际中需要替换为真实的实现

  // 确保输入是字符串
  let inputStr = '';
  if (typeof input === 'string') {
    inputStr = input;
  } else if (typeof input === 'object') {
    // 如果是对象，尝试从中提取有意义的输入
    if (input.content) {
      inputStr = input.content;
    } else if (input.query) {
      inputStr = input.query;
    } else {
      inputStr = JSON.stringify(input);
    }
  } else {
    inputStr = String(input);
  }

  // 模拟处理时间
  await new Promise(resolve => setTimeout(resolve, 300));

  // 模拟种子技能处理结果
  return {
    success: true,
    message: 'Seedance-T技能处理完成',
    input: inputStr,
    timestamp: new Date().toISOString(),
    result: {
      seedancePrompt: `[SEEDANCE_RESPONSE] 已将您的想法 "${inputStr.substring(0, 50)}..." 转换为专业分镜提示词`,
      visualization: '9-grid-storyboard',
      format: 'seedance-v2.0',
      recommendations: ['考虑添加情绪标记', '建议细化关键镜头']
    }
  };
}

/**
 * 检查技能状态的简化接口
 * 供Claude技能前端检查使用
 */
export async function checkSeedanceTAvailability(): Promise<boolean> {
  return await isSeedanceTSkillAvailable();
}

/**
 * 获取详细的技能状态
 * 供Claude技能前端状态显示使用
 */
export async function getDetailedSeedanceTStatus() {
  const result = await getSeedanceTSkillStatus();

  return {
    available: result.canUseSkill,
    statusMessage: result.message,
    remainingCredits: result.remainingCredits,
    needsRecharge: result.needsRecharge,
    // 额外的信息用于Claude技能显示
    userStatus: result.canUseSkill ? 'active' : 'restricted',
    nextSteps: result.canUseSkill
      ? ['正在处理您的请求']
      : result.needsRecharge
        ? ['充值后可继续使用']
        : ['请登录后使用']
  };
}