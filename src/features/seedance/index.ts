/**
 * Seedance-T 技能主入口
 * 用于初始化技能及其所有功能组件
 */

import { initializeSeedanceTSkill } from './claudeSkillHandler';

/**
 * 初始化整个Seedance-T技能系统
 * 应该在应用启动时调用
 */
export async function initSeedanceTSkillSystem(): Promise<boolean> {
  console.log('[Seedance-T] 初始化技能系统...');

  try {
    // 初始化技能处理器，包括更新检查和安全验证
    const initialized = await initializeSeedanceTSkill();

    if (initialized) {
      console.log('[Seedance-T] 技能系统初始化成功');
    } else {
      console.warn('[Seedance-T] 技能系统初始化完成但当前不可用');
    }

    return initialized;
  } catch (error) {
    console.error('[Seedance-T] 技能系统初始化失败:', error);
    return false;
  }
}

// 导出其他有用的方法
export {
  claudeSeedanceTSkillHandler,
  checkSeedanceTAvailability,
  getDetailedSeedanceTStatus,
  initializeSeedanceTSkill,
  getLatestUpdateInfo
} from './claudeSkillHandler';

export {
  validateSeedanceTSkillUsage,
  isSeedanceTSkillAvailable,
  getSeedanceTSkillStatus
} from './skillValidator';

export {
  checkAndPerformSkillUpdate,
  validateSkillSecurity,
  showUpdateNotification
} from './skillUpdateManager';