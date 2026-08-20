import { readProjectGlobalsMd } from '@/commands/projectState';
import { getEmphasisLabels, getVideoTypeLabel } from '@/features/project/presets';
import { buildAssetReferenceLines } from '@/commands/asset';
import { useProjectStore } from '@/stores/projectStore';

/**
 * 构建 chat 的 projectContext：项目全局参数 + 可用参考图（含视觉描述）。
 * Canvas / ProjectDashboard / ReanalyzeDialog / ChatInput 上传后统一复用，
 * 保证参考图读图描述在任意入口上传后都能即时进 skill 上下文。
 */
export async function buildProjectChatContext(projectId: string): Promise<string> {
  // 1. 优先读项目全局 MD
  let context = await readProjectGlobalsMd(projectId).catch(() => '');

  // 2. 无 MD 时从项目参数兜底
  if (!context.trim()) {
    const project = useProjectStore.getState().currentProject;
    if (project) {
      const parts: string[] = [];
      parts.push(`# ${project.name}\n`);
      parts.push('## 项目全局参数\n');
      if (project.videoType) parts.push(`- 视频类型: ${getVideoTypeLabel(project.videoType)}`);
      if (project.aspectRatio) parts.push(`- 画幅比例: ${project.aspectRatio}`);
      if (project.style) parts.push(`- 视觉风格: ${project.style}`);
      if (project.tone) parts.push(`- 项目调性: ${project.tone}`);
      if (project.directorRef) parts.push(`- 旅行视频风格: ${project.directorRef}`);
      const emphasisLabels = getEmphasisLabels(
        project.emphasisDimensions.filter((d) => d.enabled).map((d) => d.key),
      );
      if (emphasisLabels.length > 0) {
        parts.push(`- 提示词重点维度: ${emphasisLabels.join('、')}`);
      }
      context = parts.join('\n') + '\n';
    }
  }

  // 3. 追加可用参考图（含视觉描述）
  try {
    const assetLines = await buildAssetReferenceLines(projectId);
    if (assetLines.length > 0) {
      context = `${context}\n## 可用参考图\n${assetLines.join('\n')}\n\n生成分镜提示词时，如需引用参考图请使用 @图N 格式。`;
    }
  } catch {
    // assets not critical for chat — ignore errors
  }

  return context;
}
