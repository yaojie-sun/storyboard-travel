# Seedance-T 技能验证模块

## 概述
此模块提供了Seedance-T技能的权限验证功能，主要用于验证用户是否有权限在Claude中使用该技能。

## 主要功能

### 1. 权限验证
- 检查用户是否已登录小鸭中台
- 验证用户账户是否处于活跃状态
- 检查用户剩余次数是否足够使用技能

### 2. 状态检查
- 提供用户当前技能使用状态
- 返回剩余次数信息
- 生成相应的提示信息

## 使用方法

### 在前端调用
```typescript
import { claudeSeedanceTSkillHandler } from './features/seedance/claudeSkillHandler';

// 在Claude技能调用时使用
const result = await claudeSeedanceTSkillHandler(userInput);
if (result.success) {
  console.log('技能处理成功:', result.result);
} else {
  console.error('技能处理失败:', result.error);
}
```

### 简单状态检查
```typescript
import { checkSeedanceTAvailability } from './features/seedance/claudeSkillHandler';

const canUseSkill = await checkSeedanceTAvailability();
if (!canUseSkill) {
  // 提示用户需要登录或充值
}
```

## 验证逻辑
1. 检查本地设备令牌是否存在
2. 验证设备令牌是否有效（调用小鸭中台验证）
3. 检查用户剩余次数是否大于0
4. 如果任一检查失败，返回相应的错误信息

## 错误处理
- 用户未登录：返回登录提示
- 账户未激活：返回激活提示  
- 剩余次数不足：返回充值提示
- 网络错误：返回连接问题提示

## 返回格式
成功时：
```json
{
  "success": true,
  "result": {...},
  "creditsRemaining": 5
}
```

失败时：
```json
{
  "success": false,
  "error": "错误信息",
  "creditsRemaining": 0
}
```