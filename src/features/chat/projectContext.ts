import { readProjectGlobalsMd } from '@/commands/projectState';
import { getEmphasisLabels, getVideoTypeLabel } from '@/features/project/presets';
import { buildAssetReferenceLines } from '@/commands/asset';
import { useProjectStore } from '@/stores/projectStore';

/**
 * 构建 chat 的 projectContext：项目全局参数 + 可用参考图（含视觉描述）。
 * Canvas / ProjectDashboard / ReanalyzeDialog / ChatInput 上传后统一复用，
 * 保证参考图读图描述在任意入口上传后都能即时进 skill 上下文。
 */
export async function buildProjectChatContext(
  projectId: string,
  opts?: { readIfMissing?: boolean },
): Promise<string> {
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
      if (project.directorRef) parts.push(`- 视频风格: ${project.directorRef}`);
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
    const assetLines = await buildAssetReferenceLines(projectId, opts);
    if (assetLines.length > 0) {
      context = `${context}\n## 可用参考图\n${assetLines.join('\n')}\n\n` +
      '选图规则（按此顺序判断，不要跳步）：\n' +
      '1. 先按名称逐字比对：脚本里出现的人物/场景/道具名称，与上面每行的「名称」逐字对照，命中的那一张就是它。\n' +
      '2. 名称对不上时，才看「视觉描述」判断是不是同一个角色/场景/道具。\n' +
      '3. 名称与视觉描述冲突时，一律以名称为准。\n' +
      '4. 多张同类且外观接近（多个年轻女性角色、多个室内场景等）时，必须靠名称区分，按名称选对应的那一张。\n' +
      '5. @图N 的 N 是项目全局资产编号（分配后固定不变、新传图不会让它位移），不是本段的序号；以本轮资产行首的编号为准。\n\n' +
      '生成分镜/宫格提示词时用 @图N 引用参考图。请在回复中单独输出一行【选图】@图N,@图M,...，' +
      '只列出本段脚本/分镜中真实出现其角色/场景/道具的参考图编号（最多6张），' +
      '脚本未涉及、分镜未出现的角色/场景一律不选（宁缺毋滥）。';
    }
  } catch {
    // assets 不是 chat 的必需项，读失败就跳过
  }

  return context;
}
