# Token溢出管理器 - Skill集成指南

## 概述

Token溢出管理器是一个通用的、跨平台的工具，用于保护LLM API调用不超出token限制。它支持多种语言实现（Python、TypeScript），可以在不同电脑、不同环境的Skill中使用。

## 核心特性

1. **跨平台**：支持Python、TypeScript/JavaScript环境
2. **轻量级**：无复杂依赖，易于集成
3. **配置化**：支持多种LLM模型，可自定义配置
4. **安全第一**：强制安全缓冲区，防止极限溢出
5. **多种策略**：提供多种消息截断策略

## 使用场景

- 在Claude Code Skill中保护API调用
- 在独立Python脚本中管理token
- 在前端应用（React/Vue）中预计算token
- 在Node.js服务中处理长对话

## 快速开始

### Python版本

1. **复制文件**：将 `token_manager_for_skills.py` 复制到你的Skill目录
2. **基本使用**：

```python
from token_manager_for_skills import TokenManager

# 初始化管理器
manager = TokenManager("deepseek-reasoner")

# 准备消息
messages = [
    {"role": "system", "content": "你是一个助手"},
    {"role": "user", "content": "请解释量子计算"}
]

# 保护调用
safe_messages, safe_max_tokens = manager.protect(messages, 32000)

# 使用保护后的参数调用API
response = call_llm_api(
    messages=safe_messages,
    max_tokens=safe_max_tokens,
    model="deepseek-reasoner"
)
```

### TypeScript版本

1. **复制文件**：将 `tokenManager.ts` 复制到你的Skill目录
2. **基本使用**：

```typescript
import { TokenManager, TruncationStrategy } from './tokenManager';

// 初始化管理器
const manager = new TokenManager("deepseek-reasoner");

// 准备消息
const messages = [
  { role: "system", content: "你是一个助手" },
  { role: "user", content: "请解释量子计算" }
];

// 保护调用
const result = manager.protect(messages, 32000);

// 使用保护后的参数调用API
const response = await callLlmApi({
  messages: result.messages,
  max_tokens: result.maxTokens,
  model: "deepseek-reasoner"
});
```

## 集成到Claude Code Skill

### 方案A：作为Skill依赖

1. **在Skill目录中创建 `token_manager.py`**：

```python
# 你的Skill目录结构：
# my-skill/
#   ├── SKILL.md
#   ├── token_manager.py  # 复制过来的token管理器
#   └── main.py          # 你的Skill主逻辑

# main.py 中使用
from .token_manager import TokenManager

def run_skill(context):
    # 从context获取消息
    messages = context.get("messages", [])
    
    # 保护token
    manager = TokenManager("gpt-4-turbo")
    safe_messages, safe_max_tokens = manager.protect(messages, 4000)
    
    # 继续你的逻辑...
    return {"messages": safe_messages, "max_tokens": safe_max_tokens}
```

### 方案B：作为独立工具包

1. **创建工具包目录**：

```bash
token-manager-toolkit/
├── python/
│   ├── token_manager.py
│   └── requirements.txt
├── typescript/
│   ├── tokenManager.ts
│   └── package.json
├── examples/
│   ├── python_example.py
│   └── typescript_example.ts
└── README.md
```

2. **在Skill中引用**：

```python
# 假设工具包在相邻目录
import sys
sys.path.append("../token-manager-toolkit/python")

from token_manager import TokenManager
```

## 高级配置

### 自定义模型配置

```python
from token_manager_for_skills import TokenManager, ModelConfig

# 自定义配置
custom_config = ModelConfig(
    name="我的自定义模型",
    max_total_tokens=100000,
    max_output_tokens=20000,
    safety_buffer_ratio=0.15,  # 更保守的缓冲
    token_per_char=0.3,        # 调整token估算比例
)

manager = TokenManager(custom_config=custom_config)
```

### 使用精确token计数（Python）

```python
# 安装tiktoken
# pip install tiktoken

manager = TokenManager("deepseek-reasoner", use_tiktoken=True)
```

### 使用精确token计数（TypeScript）

```typescript
// 安装依赖
// npm install @dqbd/tiktoken

const manager = new TokenManager("deepseek-reasoner", undefined, true);
```

### 配置文件方式

```python
# 创建配置文件 config.json
# {
#   "name": "自定义模型",
#   "max_total_tokens": 100000,
#   "max_output_tokens": 20000,
#   "token_per_char": 0.25,
#   "overhead_per_message": 4,
#   "overhead_system": 3,
#   "safety_buffer_ratio": 0.10
# }

manager = TokenManager(config_file="config.json")
```

## 不同截断策略

```python
from token_manager_for_skills import TokenManager, TruncationStrategy

manager = TokenManager("deepseek-reasoner")

# 策略1：优先系统消息和最新消息（默认）
result1 = manager.protect(
    messages, 
    32000,
    truncation_strategy=TruncationStrategy.PRIORITIZE_SYSTEM
)

# 策略2：保留首尾消息（适合对话上下文）
result2 = manager.protect(
    messages,
    32000,
    truncation_strategy=TruncationStrategy.TRIM_FROM_MIDDLE
)

# 策略3：智能截断（按消息重要性）
result3 = manager.protect(
    messages,
    32000,
    truncation_strategy=TruncationStrategy.SMART_TRUNCATE
)
```

## 与现有Skill集成示例

### 示例1：Seedance-T Skill集成

```python
# seedance_t_skill.py
import json
from pathlib import Path
from token_manager import TokenManager

class SeedanceTSkill:
    def __init__(self):
        self.token_manager = TokenManager("deepseek-reasoner")
        
    def process_request(self, request_data):
        # 提取消息
        messages = request_data.get("messages", [])
        prompt = request_data.get("prompt", "")
        
        # 如果需要，将prompt转换为消息格式
        if prompt and not messages:
            messages = [
                {"role": "system", "content": "你是一个视频分镜助手"},
                {"role": "user", "content": prompt}
            ]
        
        # 保护token
        safe_messages, safe_max_tokens = self.token_manager.protect(
            messages,
            requested_max_tokens=32000
        )
        
        # 分析使用情况
        analysis = self.token_manager.analyze_usage(messages)
        
        # 记录日志
        self.log_usage(analysis)
        
        # 返回保护后的参数
        return {
            "safe_messages": safe_messages,
            "safe_max_tokens": safe_max_tokens,
            "original_count": len(messages),
            "safe_count": len(safe_messages),
            "needed_truncation": analysis["needs_truncation"]
        }
    
    def log_usage(self, analysis):
        print(f"Token使用分析:")
        print(f"  总token数: {analysis['total_tokens']}")
        print(f"  安全上限: {analysis['max_allowed']}")
        print(f"  使用率: {analysis['usage_percentage']:.1f}%")
        print(f"  需要截断: {analysis['needs_truncation']}")
```

### 示例2：前端Skill集成（浏览器）

```typescript
// browser-skill.ts
import { TokenManager, TruncationStrategy } from './tokenManager';

export class BrowserSkill {
  private tokenManager: TokenManager;
  
  constructor() {
    // 使用适合浏览器的模型配置
    this.tokenManager = new TokenManager("gpt-3.5-turbo");
  }
  
  async processChat(messages: Array<{role: string, content: string}>) {
    // 保护token
    const result = this.tokenManager.protect(
      messages,
      2000, // 较小的输出限制
      TruncationStrategy.PRIORITIZE_SYSTEM,
      256   // 最小输出
    );
    
    // 显示分析结果
    const analysis = this.tokenManager.analyzeUsage(messages);
    this.showTokenInfo(analysis);
    
    // 调用API
    return await this.callApi(result.messages, result.maxTokens);
  }
  
  private showTokenInfo(analysis: any) {
    const infoDiv = document.getElementById('token-info');
    if (infoDiv) {
      infoDiv.innerHTML = `
        <div class="token-stats">
          <p>Token使用: ${analysis.totalTokens} / ${analysis.maxAllowed}</p>
          <p>使用率: ${analysis.usagePercentage.toFixed(1)}%</p>
          <p>${analysis.needsTruncation ? '⚠️ 需要优化' : '✅ 正常'}</p>
        </div>
      `;
    }
  }
  
  private async callApi(messages: any[], maxTokens: number) {
    // 你的API调用逻辑
    // ...
  }
}
```

## 性能优化建议

### 1. 缓存token计数结果

```python
from functools import lru_cache

class OptimizedTokenManager(TokenManager):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._token_cache = {}
    
    @lru_cache(maxsize=1000)
    def count_tokens_cached(self, text: str) -> int:
        return super().count_tokens(text)
```

### 2. 批量处理

```python
# 批量保护多个请求
def batch_protect(requests):
    manager = TokenManager("deepseek-reasoner")
    results = []
    
    for req in requests:
        result = manager.protect(req["messages"], req["max_tokens"])
        results.append(result)
    
    return results
```

### 3. 渐进式保护

```python
def progressive_protection(messages, max_tokens):
    manager = TokenManager("deepseek-reasoner")
    
    # 先尝试不截断
    try:
        return manager.protect(messages, max_tokens)
    except ValueError:
        # 如果失败，逐步降低要求
        for reduced_max in [max_tokens // 2, max_tokens // 4, 512]:
            try:
                return manager.protect(messages, reduced_max)
            except ValueError:
                continue
    
    # 最终尝试最小配置
    return manager.protect(messages, 512)
```

## 测试验证

### 单元测试示例（Python）

```python
# test_token_manager.py
import unittest
from token_manager import TokenManager

class TestTokenManager(unittest.TestCase):
    def setUp(self):
        self.manager = TokenManager("deepseek-reasoner")
    
    def test_basic_protection(self):
        messages = [
            {"role": "user", "content": "Hello"}
        ]
        
        safe_messages, safe_max = self.manager.protect(messages, 1000)
        
        self.assertLessEqual(len(safe_messages), len(messages))
        self.assertLessEqual(safe_max, 1000)
    
    def test_long_conversation(self):
        # 创建超长对话
        messages = []
        for i in range(100):
            messages.append({"role": "user", "content": f"Message {i}"})
        
        safe_messages, safe_max = self.manager.protect(messages, 32000)
        
        # 应该被截断
        self.assertLess(len(safe_messages), len(messages))
        self.assertGreater(safe_max, 0)
    
    def test_system_message_preservation(self):
        messages = [
            {"role": "system", "content": "重要系统提示"},
            {"role": "user", "content": "A" * 10000},  # 很长
            {"role": "user", "content": "B" * 10000},
        ]
        
        safe_messages, _ = self.manager.protect(messages, 1000)
        
        # 系统消息应该被保留
        self.assertEqual(safe_messages[0]["role"], "system")

if __name__ == '__main__':
    unittest.main()
```

### 集成测试示例

```python
# integration_test.py
def test_with_real_api():
    """与真实API集成测试"""
    import requests
    
    manager = TokenManager("gpt-3.5-turbo")
    
    # 模拟长对话
    messages = [
        {"role": "system", "content": "你是一个翻译助手"},
        {"role": "user", "content": "请翻译以下文本..." + ("很长" * 1000)},
    ]
    
    # 保护
    safe_messages, safe_max = manager.protect(messages, 1000)
    
    # 调用API
    response = requests.post(
        "https://api.openai.com/v1/chat/completions",
        headers={"Authorization": "Bearer YOUR_API_KEY"},
        json={
            "model": "gpt-3.5-turbo",
            "messages": safe_messages,
            "max_tokens": safe_max,
        }
    )
    
    assert response.status_code == 200
    print("集成测试通过!")
```

## 故障排除

### 常见问题

1. **Q: 消息被过度截断**
   - **A**: 调整`safety_buffer_ratio`降低安全缓冲区（如从0.10改为0.05）
   - **A**: 使用`TRIM_FROM_MIDDLE`策略保留更多上下文

2. **Q: Token计数不准确**
   - **A**: 启用`use_tiktoken=True`使用精确计数（需要安装tiktoken）
   - **A**: 调整`token_per_char`参数适应你的文本类型

3. **Q: 性能问题**
   - **A**: 实现缓存机制（见性能优化部分）
   - **A**: 对于近似算法，结果已经很快，如果还慢可能是消息过多

4. **Q: 不支持我的模型**
   - **A**: 创建自定义`ModelConfig`配置你的模型
   - **A**: 提交Issue或PR到项目，添加新模型支持

### 调试日志

```python
# 启用详细日志
import logging

logging.basicConfig(level=logging.DEBUG)

manager = TokenManager("deepseek-reasoner")

# 或者在保护时打印信息
safe_messages, safe_max = manager.protect(messages, 32000)
print(f"原始: {len(messages)}条，保护后: {len(safe_messages)}条")
print(f"Max tokens: {safe_max}")

# 分析详情
analysis = manager.analyze_usage(messages)
print(f"使用分析: {analysis}")
```

## 贡献与扩展

### 添加新模型支持

1. **编辑MODEL_CONFIGS字典**：

```python
# 在token_manager_for_skills.py中添加
MODEL_CONFIGS["my-new-model"] = ModelConfig(
    name="我的新模型",
    max_total_tokens=200000,
    max_output_tokens=10000,
    token_per_char=0.25,
)
```

2. **创建配置文件**：

```bash
python token_manager_for_skills.py --create-config my-new-model --output my-model.json
```

### 实现新语言版本

参考现有实现，保持API一致性：

1. 相同的`ModelConfig`结构
2. 相同的`protect()`方法签名
3. 相同的截断策略枚举
4. 相似的分析和工具函数

## 许可证与致谢

本项目采用MIT许可证，基于用户提供的DeepSeek token管理代码扩展而来。

主要改进：
1. 多语言支持（Python、TypeScript）
2. 多模型配置
3. 多种截断策略
4. 更好的错误处理
5. 性能优化建议

## 更新日志

### v1.0.0 (初始版本)
- 基于原始DeepSeek token管理代码
- 添加多模型支持
- 添加TypeScript版本
- 完善文档和示例

### v1.1.0 (计划中)
- 添加Rust版本
- 添加WebAssembly版本
- 添加更多预置模型
- 性能基准测试

---

如有问题或建议，请提交Issue或PR。祝你集成顺利！