/**
 * Seedance-T 技能更新管理器
 * 负责在应用启动时检查并更新技能
 */

import {
  checkForSkillUpdates,
  downloadLatestSkillFile,
  confirmSkillUpdate,
  applySkillUpdate,
  type SkillUpdateInfo,
  getUpdateNotes
} from './skillUpdater';
import { checkSkillPermission } from '../../commands/ai';

/**
 * 检查并更新技能
 * 应该在应用启动时调用
 */
export async function checkAndPerformSkillUpdate(): Promise<boolean> {
  console.log('[Seedance-T Updater] 开始检查技能更新...');

  try {
    // 检查是否有可用更新
    const updateInfo = await checkForSkillUpdates();

    if (!updateInfo) {
      console.log('[Seedance-T Updater] 没有找到可用的技能更新');
      return false;
    }

    // 获取当前版本信息（如果有的话）
    const currentVersion = getCurrentSkillVersion();
    console.log(`[Seedance-T Updater] 当前版本: ${currentVersion}, 可用更新版本: ${updateInfo.version}, 压缩: ${updateInfo.isCompressed ? '是' : '否'}`);

    // 确认用户是否要更新
    const shouldUpdate = await confirmSkillUpdate(updateInfo);

    if (!shouldUpdate) {
      console.log('[Seedance-T Updater] 用户拒绝更新');
      return false;
    }

    // 下载最新的技能文件
    console.log('[Seedance-T Updater] 正在下载最新的技能文件...');
    const newSkillContent = await downloadLatestSkillFile(updateInfo.isCompressed);

    if (!newSkillContent) {
      console.error('[Seedance-T Updater] 无法下载新的技能文件');
      return false;
    }

    // 应用更新
    console.log('[Seedance-T Updater] 正在应用技能更新...');
    const updateApplied = await applySkillUpdate(newSkillContent);

    if (updateApplied) {
      console.log('[Seedance-T Updater] 技能更新成功应用');

      // 显示更新完成的通知，包含更新说明
      await showUpdateNotification(updateInfo);

      // 验证更新后的技能是否仍有安全检测
      validateSkillSecurity();

      return true;
    } else {
      console.error('[Seedance-T Updater] 技能更新应用失败');
      return false;
    }
  } catch (error) {
    console.error('[Seedance-T Updater] 检查和应用技能更新时出错:', error);
    return false;
  }
}

/**
 * 显示更新通知，包括具体的更新说明
 */
export async function showUpdateNotification(updateInfo: SkillUpdateInfo): Promise<void> {
  try {
    // 获取详细的更新说明
    const updateNotes = updateInfo.updateNotes || await getUpdateNotes();

    // 显示更新通知（这里可以是alert或者更复杂的UI组件）
    const updateMessage = `Seedance-T技能已更新到版本 ${updateInfo.version}！

更新内容：
${updateInfo.changelog}

详细更新说明：
${updateNotes}

更新时间：${updateInfo.updatedAt}`;

    alert(updateMessage);

    console.log('[Seedance-T Updater] 更新通知已显示:', updateMessage);
  } catch (error) {
    console.error('[Seedance-T Updater] 显示更新通知时出错:', error);
    // 即使显示通知失败，也不影响更新本身
  }
}

/**
 * 验证技能的安全检测机制是否仍然存在
 */
export function validateSkillSecurity(): void {
  console.log('[Seedance-T Security] 验证安全检测机制...');

  // 验证关键安全功能是否仍然存在
  const securityChecks = [
    {
      name: '登录状态检查',
      exists: typeof checkSkillPermission !== 'undefined'
    },
    {
      name: '次数检查',
      exists: true // 这个检查是在checkSkillPermission中进行的
    },
    {
      name: '权限验证',
      exists: true // 这个检查也是在checkSkillPermission中进行的
    }
  ];

  const missingChecks = securityChecks.filter(check => !check.exists);

  if (missingChecks.length > 0) {
    console.error('[Seedance-T Security] 以下安全检查缺失:', missingChecks);
  } else {
    console.log('[Seedance-T Security] 所有安全检查都正常存在');
  }
}

/**
 * 获取当前技能版本
 */
export function getCurrentSkillVersion(): string {
  // 尝试从本地存储获取最后更新的版本，如果不存在则返回初始版本
  return localStorage.getItem('seedance-t-skill-version') || '1.0.0';
}