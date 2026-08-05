/**
 * 检查技能访问权限
 * 通过事件系统与App组件通信
 * @returns Promise<boolean> - 是否允许使用技能
 */
export function checkSkillAccess(): Promise<boolean> {
  return new Promise((resolve) => {
    // 创建自定义事件，传递resolve函数
    const event = new CustomEvent('skill-access-check', {
      detail: { resolve }
    });

    // 触发事件
    window.dispatchEvent(event);
  });
}