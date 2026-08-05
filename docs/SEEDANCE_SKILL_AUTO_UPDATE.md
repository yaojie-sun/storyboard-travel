# Seedance-T 技能自动更新功能

## 功能概述
新增了Seedance-T技能的自动更新功能，能够：
1. 在应用启动时自动检查服务器上的技能更新
2. 当检测到更新时询问用户是否应用更新
3. 确保更新后技能的安全检测机制保持不变

## 核心功能

### 1. 自动更新检查
- 应用启动时自动检查服务器上的最新技能版本
- 通过 `http://47.108.237.10/jy/api/v1/skill/file` 端点获取最新版本
- 只有已登录用户才能检查更新

### 2. 用户确认机制
- 检测到更新时会弹出确认对话框
- 显示更新版本、变更日志和更新时间
- 用户可以选择接受或拒绝更新

### 3. 安全验证
- 更新后自动验证安全检测机制是否依然有效
- 确保登录检查、次数检查和权限验证功能完好

## 使用方法

### 在应用启动时集成
```typescript
import { initSeedanceTSkillSystem } from './features/seedance';

// 在应用启动时调用
const skillSystemReady = await initSeedanceTSkillSystem();
if (skillSystemReady) {
  console.log('Seedance-T技能系统已就绪');
} else {
  console.log('Seedance-T技能系统不可用');
}
```

### 直接调用技能处理器
```typescript
import { claudeSeedanceTSkillHandler } from './features/seedance';

// 处理来自Claude的技能请求
const result = await claudeSeedanceTSkillHandler(userInput);
if (result.success) {
  console.log('技能处理成功:', result.result);
} else {
  console.error('技能处理失败:', result.error);
}
```

### 检查技能状态
```typescript
import { checkSeedanceTAvailability } from './features/seedance';

const canUseSkill = await checkSeedanceTAvailability();
if (!canUseSkill) {
  // 提示用户需要登录或充值
}
```

## 更新流程
1. 应用启动时自动调用 `checkAndPerformSkillUpdate()`
2. 从服务器获取最新技能文件信息
3. 对比当前版本与服务器版本
4. 如果有更新，询问用户是否更新
5. 用户同意后下载并应用更新
6. 验证更新后安全机制是否仍然有效

## 安全保障
- 所有安全检查（登录验证、次数检查、权限验证）在更新后都会保持
- 不能绕过任何现有的安全验证机制
- 更新仅限于技能功能逻辑，不影响安全架构

## 错误处理
- 网络错误：静默失败，不影响主要功能
- 验证失败：提示用户检查网络或重新登录
- 更新中断：保持当前版本，下次启动时重新检查