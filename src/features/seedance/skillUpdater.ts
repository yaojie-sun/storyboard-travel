/**
 * Seedance-T 技能自动更新检查器
 * 用于检测服务器上的技能更新并在用户同意的情况下自动更新
 * 支持处理来自seedance-auto-doc的压缩文件格式和更新说明
 */

import { checkSkillPermission } from "../../commands/ai";
import { gunzipSync } from 'fflate';

export interface SkillUpdateInfo {
  version: string;
  downloadUrl: string;
  changelog: string;
  hash: string; // 用于验证文件完整性
  updatedAt: string;
  isCompressed?: boolean; // 标记文件是否为压缩格式
  updateNotes?: string; // 更新说明
}

/**
 * 检查是否有可用的技能更新
 * 从服务器获取最新的seedance-t技能版本信息
 */
export async function checkForSkillUpdates(): Promise<SkillUpdateInfo | null> {
  try {
    // 首先检查用户是否有权限访问更新检查（需要登录）
    const permission = await checkSkillPermission();

    if (!permission.allowed) {
      console.log('[Seedance-T Updater] 用户未登录，跳过更新检查');
      return null;
    }

    // 尝试从小鸭中台获取技能更新信息
    // 首先检查最新的文件列表，查看是否有压缩文件
    const fileListResponse = await fetch('https://aixiaoxi.top/jy/api/v1/skill/files');

    if (fileListResponse.ok) {
      const fileListData = await fileListResponse.json();

      if (fileListData.success && fileListData.data && Array.isArray(fileListData.data)) {
        // 查找最新的skill文件（可能是压缩文件）
        const skillFiles = fileListData.data
          .filter((file: any) => file.filename.startsWith('skill'))
          .sort((a: any, b: any) => new Date(b.uploaded_at).getTime() - new Date(a.uploaded_at).getTime());

        if (skillFiles.length > 0) {
          const latestFile = skillFiles[0];

          // 尝试获取更新说明
          let updateNotes = '';
          try {
            // 尝试获取专门的更新说明
            const notesResponse = await fetch('https://aixiaoxi.top/jy/api/v1/skill/changelog');
            if (notesResponse.ok) {
              const notesData = await notesResponse.json();
              updateNotes = notesData.changelog || notesData.notes || '';
            }
          } catch (notesError) {
            console.warn('[Seedance-T Updater] 获取更新说明失败:', notesError);
          }

          return {
            version: latestFile.version || latestFile.filename || 'latest',
            downloadUrl: `https://aixiaoxi.top/jy/api/v1/skill/download/${encodeURIComponent(latestFile.filename)}`,
            changelog: latestFile.description || '最新版本更新',
            hash: latestFile.sha256_hash || latestFile.hash || '',
            updatedAt: latestFile.uploaded_at,
            isCompressed: latestFile.filename.endsWith('.gz') || latestFile.filename.endsWith('.zip'),
            updateNotes: updateNotes
          };
        }
      }
    }

    // 如果无法获取文件列表或没有找到合适的文件，尝试直接获取skill文件
    const response = await fetch('https://aixiaoxi.top/jy/api/v1/skill/file');

    if (!response.ok) {
      console.warn('[Seedance-T Updater] 获取技能更新信息失败:', response.status);
      return null;
    }

    const data = await response.json();

    if (!data.success || !data.content) {
      console.warn('[Seedance-T Updater] 响应格式不正确或没有内容');
      return null;
    }

    // 尝试获取更新说明
    let updateNotes = '';
    try {
      const notesResponse = await fetch('https://aixiaoxi.top/jy/api/v1/skill/changelog');
      if (notesResponse.ok) {
        const notesData = await notesResponse.json();
        updateNotes = notesData.changelog || notesData.notes || '';
      }
    } catch (notesError) {
      console.warn('[Seedance-T Updater] 获取更新说明失败:', notesError);
    }

    // 从响应中提取版本信息（如果有的话）
    // 如果服务器没有版本信息，我们可以通过其他方式标识
    return {
      version: data.version || 'latest',
      downloadUrl: 'https://aixiaoxi.top/jy/api/v1/skill/file',
      changelog: data.changelog || '最新版本更新',
      hash: data.sha256_hash || '',
      updatedAt: data.updatedAt || new Date().toISOString(),
      isCompressed: false,
      updateNotes: updateNotes
    };
  } catch (error) {
    console.error('[Seedance-T Updater] 检查更新时出错:', error);
    return null;
  }
}

/**
 * 下载最新的技能文件
 */
export async function downloadLatestSkillFile(isCompressed: boolean = false): Promise<string | null> {
  try {
    let url = 'https://aixiaoxi.top/jy/api/v1/skill/file';

    // 尝试从文件列表获取最新的文件URL
    const fileListResponse = await fetch('https://aixiaoxi.top/jy/api/v1/skill/files');

    if (fileListResponse.ok) {
      const fileListData = await fileListResponse.json();

      if (fileListData.success && fileListData.data && Array.isArray(fileListData.data)) {
        const skillFiles = fileListData.data
          .filter((file: any) => file.filename.startsWith('skill'))
          .sort((a: any, b: any) => new Date(b.uploaded_at).getTime() - new Date(a.uploaded_at).getTime());

        if (skillFiles.length > 0) {
          const latestFile = skillFiles[0];
          url = `https://aixiaoxi.top/jy/api/v1/skill/download/${encodeURIComponent(latestFile.filename)}`;
          isCompressed = latestFile.filename.endsWith('.gz') || latestFile.filename.endsWith('.zip');
        }
      }
    }

    const response = await fetch(url);

    if (!response.ok) {
      console.error('[Seedance-T Updater] 下载技能文件失败:', response.status);
      return null;
    }

    if (isCompressed) {
      // 处理压缩文件
      const buffer = await response.arrayBuffer();
      try {
        // 尝试解压（假设是gzip格式）
        const decompressed = gunzipSync(new Uint8Array(buffer));
        return new TextDecoder().decode(decompressed);
      } catch (decompressError) {
        console.error('[Seedance-T Updater] 解压文件失败:', decompressError);

        // 如果是其他压缩格式，可能需要不同的处理方式
        // 尝试作为普通文本处理
        try {
          return new TextDecoder().decode(new Uint8Array(buffer));
        } catch (textDecodeError) {
          console.error('[Seedance-T Updater] 解码文件失败:', textDecodeError);
          return null;
        }
      }
    } else {
      // 处理普通文本文件
      return await response.text();
    }
  } catch (error) {
    console.error('[Seedance-T Updater] 下载技能文件时出错:', error);
    return null;
  }
}

/**
 * 询问用户是否更新技能
 * 这里简化处理，实际应用中可能需要更复杂的UI
 */
export function confirmSkillUpdate(updateInfo: SkillUpdateInfo): Promise<boolean> {
  return new Promise((resolve) => {
    // 在实际应用中，这里会显示一个确认对话框
    const updateType = updateInfo.isCompressed ? '（压缩文件）' : '';
    const updateDetails = updateInfo.updateNotes ? `\n\n更新详情:\n${updateInfo.updateNotes}` : '';

    const shouldUpdate = confirm(
      `发现Seedance-T技能的新版本 ${updateType}(${updateInfo.version})\n\n` +
      `更新内容: ${updateInfo.changelog}\n` +
      `更新时间: ${updateInfo.updatedAt}${updateDetails}\n\n` +
      `是否立即更新？`
    );

    resolve(shouldUpdate);
  });
}

/**
 * 获取当前技能版本（本地）
 * 由于我们主要是前端逻辑，这里简单返回一个固定的版本号
 */
export function getCurrentSkillVersion(): string {
  // 在实际应用中，这里可能会读取本地存储的版本信息
  return localStorage.getItem('seedance-t-skill-version') || '1.0.0';
}

/**
 * 应用技能更新
 * @param newSkillContent 新的技能内容
 */
export async function applySkillUpdate(newSkillContent: string): Promise<boolean> {
  try {
    // 在实际应用中，这里会将新的技能内容保存到适当的位置
    // 并可能需要重启相关的服务或重新加载技能

    // 为了安全起见，我们可以将内容存储到本地存储中
    localStorage.setItem('seedance-t-skill-content', newSkillContent);
    localStorage.setItem('seedance-t-skill-updated', new Date().toISOString());

    console.log('[Seedance-T Updater] 技能更新应用成功');

    return true;
  } catch (error) {
    console.error('[Seedance-T Updater] 应用技能更新失败:', error);
    return false;
  }
}

/**
 * 获取更新说明
 * 在更新完成后向用户展示具体的更新内容
 */
export async function getUpdateNotes(): Promise<string> {
  try {
    const response = await fetch('https://aixiaoxi.top/jy/api/v1/skill/changelog');

    if (response.ok) {
      const data = await response.json();
      return data.changelog || data.notes || '暂无更新说明';
    }

    return '暂无更新说明';
  } catch (error) {
    console.error('[Seedance-T Updater] 获取更新说明失败:', error);
    return '暂无更新说明';
  }
}