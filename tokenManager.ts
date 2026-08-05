/**
 * 通用Token溢出管理器 - TypeScript/JavaScript版本
 *
 * 设计目标：
 * 1. 跨平台运行（浏览器、Node.js、Deno等）
 * 2. 无外部依赖（纯TypeScript/JavaScript）
 * 3. 与Python版本保持API兼容
 * 4. 易于集成到各种Skill中
 *
 * 使用说明：
 * 1. 复制本文件到你的Skill项目中
 * 2. 导入并使用 TokenManager 类
 * 3. 或作为模块使用
 */

// ===================== 配置与类型定义 =====================

export enum TruncationStrategy {
  /** 优先保留系统提示和最新消息（默认） */
  PRIORITIZE_SYSTEM = "prioritize_system",
  /** 从中间开始移除，保留首尾 */
  TRIM_FROM_MIDDLE = "trim_from_middle",
  /** 从开始处移除，保留最新消息 */
  TRIM_FROM_START = "trim_from_start",
  /** 从末尾移除，保留最早消息 */
  TRIM_FROM_END = "trim_from_end",
  /** 智能截断（基于重要性评估） */
  SMART_TRUNCATE = "smart_truncate"
}

export interface Message {
  role: string;
  content: string;
}

export interface ModelConfig {
  /** 模型显示名称 */
  name: string;
  /** 模型最大上下文长度 */
  maxTotalTokens: number;
  /** 模型最大输出长度 */
  maxOutputTokens: number;
  /** 字符到token的近似比例（英文） */
  tokenPerChar: number;
  /** 每条消息的格式开销 */
  overheadPerMessage: number;
  /** 系统级格式开销 */
  overheadSystem: number;
  /** 安全缓冲区比例（默认10%） */
  safetyBufferRatio: number;
  /** 编码器名称（如使用tiktoken） */
  encoding?: string;
}

export interface ProtectResult {
  messages: Message[];
  maxTokens: number;
}

export interface UsageAnalysis {
  totalTokens: number;
  maxAllowed: number;
  usagePercentage: number;
  remainingTokens: number;
  needsTruncation: boolean;
  modelConfig: ModelConfig;
}

// 预定义模型配置（支持常见LLM）
export const MODEL_CONFIGS: Record<string, ModelConfig> = {
  // DeepSeek 系列
  "deepseek-reasoner": {
    name: "DeepSeek Reasoner",
    maxTotalTokens: 131072,
    maxOutputTokens: 32000,
    tokenPerChar: 0.25,
    overheadPerMessage: 4,
    overheadSystem: 3,
    safetyBufferRatio: 0.10,
  },
  "deepseek-chat": {
    name: "DeepSeek Chat",
    maxTotalTokens: 32768,
    maxOutputTokens: 4096,
    tokenPerChar: 0.25,
    overheadPerMessage: 4,
    overheadSystem: 3,
    safetyBufferRatio: 0.10,
  },

  // OpenAI 系列
  "gpt-4-turbo": {
    name: "GPT-4 Turbo",
    maxTotalTokens: 128000,
    maxOutputTokens: 4096,
    tokenPerChar: 0.25,
    overheadPerMessage: 4,
    overheadSystem: 3,
    safetyBufferRatio: 0.10,
  },
  "gpt-3.5-turbo": {
    name: "GPT-3.5 Turbo",
    maxTotalTokens: 16385,
    maxOutputTokens: 4096,
    tokenPerChar: 0.25,
    overheadPerMessage: 4,
    overheadSystem: 3,
    safetyBufferRatio: 0.10,
  },

  // Anthropic 系列
  "claude-3-5-sonnet": {
    name: "Claude 3.5 Sonnet",
    maxTotalTokens: 200000,
    maxOutputTokens: 8192,
    tokenPerChar: 0.28, // Claude token略大
    overheadPerMessage: 4,
    overheadSystem: 3,
    safetyBufferRatio: 0.10,
  },

  // 通用配置
  "default": {
    name: "Default Model",
    maxTotalTokens: 32000,
    maxOutputTokens: 2000,
    tokenPerChar: 0.25,
    overheadPerMessage: 4,
    overheadSystem: 3,
    safetyBufferRatio: 0.10,
  },
};

// ===================== 核心Token管理器 =====================

export class TokenManager {
  private config: ModelConfig;
  private useTiktoken: boolean = false;
  private tiktokenEncoder: any = null;

  /**
   * 初始化Token管理器
   *
   * @param model 模型名称（必须是MODEL_CONFIGS中的key或"default"）
   * @param customConfig 自定义模型配置（优先于model参数）
   * @param useTiktoken 是否使用tiktoken进行精确计数（需要安装@dqbd/tiktoken）
   * @param configData 自定义配置数据（JSON字符串或对象）
   */
  constructor(
    model: string = "deepseek-reasoner",
    customConfig?: ModelConfig,
    useTiktoken: boolean = false,
    configData?: string | object
  ) {
    // 加载配置
    if (customConfig) {
      this.config = customConfig;
    } else if (configData) {
      this.config = this.parseConfig(configData);
    } else if (MODEL_CONFIGS[model]) {
      this.config = MODEL_CONFIGS[model];
    } else {
      console.warn(`警告：未知模型 '${model}'，使用默认配置`);
      this.config = MODEL_CONFIGS["default"];
    }

    this.useTiktoken = useTiktoken;

    // 动态加载tiktoken（如果需要）
    if (useTiktoken && typeof window === 'undefined') {
      // Node.js环境
      this.initializeTiktoken().catch(err => {
        console.warn(`无法初始化tiktoken: ${err.message}，使用近似算法`);
        this.useTiktoken = false;
      });
    }
  }

  private async initializeTiktoken(): Promise<void> {
    try {
      // 动态导入，避免强制依赖
      const { Tiktoken } = await import('@dqbd/tiktoken');
      const cl100kBase = await import('@dqbd/tiktoken/encoders/cl100k_base.json');

      this.tiktokenEncoder = new Tiktoken(
        cl100kBase.bpe_ranks,
        cl100kBase.special_tokens,
        cl100kBase.pat_str
      );

      console.log(`已启用tiktoken精确计数（编码：${this.config.encoding || 'cl100k_base'}）`);
    } catch (error) {
      throw new Error(`tiktoken初始化失败: ${error}`);
    }
  }

  private parseConfig(configData: string | object): ModelConfig {
    if (typeof configData === 'string') {
      return JSON.parse(configData) as ModelConfig;
    }
    return configData as ModelConfig;
  }

  /**
   * 计算文本的token数
   *
   * 策略：
   * 1. 如果启用tiktoken且可用，使用精确计数
   * 2. 否则使用基于字符的近似算法
   */
  countTokens(text: string): number {
    if (!text) {
      return 0;
    }

    // 如果启用了tiktoken并且在Node.js环境中可用
    if (this.useTiktoken && this.tiktokenEncoder && typeof window === 'undefined') {
      try {
        return this.tiktokenEncoder.encode(text).length;
      } catch (error) {
        console.warn('tiktoken编码失败，使用近似算法:', error);
      }
    }

    // 近似算法：考虑中英文差异
    // 英文：~4字符/token，中文：~2字符/token
    const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const otherChars = text.length - chineseChars;

    // 中文每个字符约0.5 token，其他字符约0.25 token
    const estimatedTokens = Math.floor(
      chineseChars * 0.5 + otherChars * this.config.tokenPerChar
    );

    // 确保至少为1
    return Math.max(1, estimatedTokens);
  }

  /**
   * 计算单条消息的token数（包含格式开销）
   */
  countMessageTokens(message: Message): number {
    const content = message.content || '';
    const role = message.role || '';

    // 内容token数
    let tokens = this.countTokens(content);

    // 角色token数（如果存在）
    if (role) {
      tokens += this.countTokens(role);
    }

    // 每条消息的固定开销
    tokens += this.config.overheadPerMessage;

    return tokens;
  }

  /**
   * 计算整个消息列表的总token数
   */
  calculateTotalInputTokens(messages: Message[]): number {
    if (!messages || messages.length === 0) {
      return 0;
    }

    let total = 0;
    for (const message of messages) {
      total += this.countMessageTokens(message);
    }

    // 系统开销
    total += this.config.overheadSystem;

    return total;
  }

  /**
   * 保护API调用不超出token限制
   *
   * @param messages 原始消息列表
   * @param requestedMaxTokens 请求的最大输出token数
   * @param truncationStrategy 截断策略
   * @param minOutputTokens 最小输出token数（确保有足够输出空间）
   * @param preserveSystem 是否始终保留系统消息
   * @returns 保护后的消息和安全的max_tokens
   */
  protect(
    messages: Message[],
    requestedMaxTokens: number,
    truncationStrategy: TruncationStrategy = TruncationStrategy.PRIORITIZE_SYSTEM,
    minOutputTokens: number = 512,
    preserveSystem: boolean = true
  ): ProtectResult {
    // 1. 参数校验
    if (!messages || messages.length === 0) {
      throw new Error("消息列表不能为空");
    }

    if (requestedMaxTokens < minOutputTokens) {
      throw new Error(
        `请求的max_tokens(${requestedMaxTokens})小于最小输出要求(${minOutputTokens})`
      );
    }

    // 2. 计算安全红线
    const maxAllowedTotal = Math.floor(
      this.config.maxTotalTokens * (1 - this.config.safetyBufferRatio)
    );

    // 3. 先尝试只调整max_tokens（不截断消息）
    const currentInputTokens = this.calculateTotalInputTokens(messages);

    // 可用输出空间 = 安全红线 - 当前输入 - 额外缓冲
    const availableForOutput = maxAllowedTotal - currentInputTokens - 1000;

    let safeMaxTokens = Math.min(
      requestedMaxTokens,
      this.config.maxOutputTokens,
      Math.max(availableForOutput, minOutputTokens)
    );

    if (safeMaxTokens >= minOutputTokens) {
      // 调整max_tokens即可满足
      return {
        messages: [...messages],
        maxTokens: safeMaxTokens,
      };
    }

    // 4. 需要截断消息
    const safeMessages = this.truncateMessages(
      messages,
      maxAllowedTotal,
      truncationStrategy,
      minOutputTokens,
      preserveSystem
    );

    // 5. 重新计算安全max_tokens
    const finalInputTokens = this.calculateTotalInputTokens(safeMessages);
    const finalAvailable = maxAllowedTotal - finalInputTokens - 500;

    const finalSafeMaxTokens = Math.min(
      requestedMaxTokens,
      this.config.maxOutputTokens,
      Math.max(finalAvailable, minOutputTokens)
    );

    return {
      messages: safeMessages,
      maxTokens: finalSafeMaxTokens,
    };
  }

  private truncateMessages(
    messages: Message[],
    maxAllowedTotal: number,
    truncationStrategy: TruncationStrategy,
    minOutputTokens: number,
    preserveSystem: boolean
  ): Message[] {
    // 分离系统消息和其他消息
    const systemMessages: Message[] = [];
    const otherMessages: Message[] = [];

    for (const msg of messages) {
      if (preserveSystem && msg.role === "system") {
        systemMessages.push(msg);
      } else {
        otherMessages.push(msg);
      }
    }

    const safeMessages: Message[] = [];
    let usedTokens = 0;

    // 始终保留系统消息（如果启用）
    if (systemMessages.length > 0) {
      for (const sysMsg of systemMessages) {
        const sysTokens = this.countMessageTokens(sysMsg);
        if (usedTokens + sysTokens <= maxAllowedTotal - minOutputTokens - 1000) {
          safeMessages.push(sysMsg);
          usedTokens += sysTokens;
        } else {
          // 系统消息都放不下，发出警告
          console.warn(`警告：系统消息token数(${sysTokens})已超过安全限制`);
        }
      }
    }

    // 根据策略处理其他消息
    const targetSpace = maxAllowedTotal - usedTokens - minOutputTokens - 1000;

    if (truncationStrategy === TruncationStrategy.PRIORITIZE_SYSTEM) {
      // 保留最新消息（原策略）
      for (let i = otherMessages.length - 1; i >= 0; i--) {
        const msg = otherMessages[i];
        const msgTokens = this.countMessageTokens(msg);
        if (usedTokens + msgTokens <= targetSpace) {
          safeMessages.splice(systemMessages.length, 0, msg); // 插入到系统消息后
          usedTokens += msgTokens;
        } else {
          break;
        }
      }
    } else if (truncationStrategy === TruncationStrategy.TRIM_FROM_MIDDLE) {
      // 从中间开始移除（保留首尾重要上下文）
      if (otherMessages.length > 0) {
        // 尝试保留第一条和最后一条
        if (otherMessages.length >= 2) {
          const firstMsg = otherMessages[0];
          const lastMsg = otherMessages[otherMessages.length - 1];

          const firstTokens = this.countMessageTokens(firstMsg);
          const lastTokens = this.countMessageTokens(lastMsg);

          if (usedTokens + firstTokens + lastTokens <= targetSpace) {
            safeMessages.push(firstMsg, lastMsg);
            usedTokens += firstTokens + lastTokens;
          }
        } else {
          // 只有一条消息
          const msg = otherMessages[0];
          const msgTokens = this.countMessageTokens(msg);
          if (usedTokens + msgTokens <= targetSpace) {
            safeMessages.push(msg);
            usedTokens += msgTokens;
          }
        }
      }
    } else if (truncationStrategy === TruncationStrategy.TRIM_FROM_START) {
      // 从开始处移除（保留最新）
      for (let i = otherMessages.length - 1; i >= 0; i--) {
        const msg = otherMessages[i];
        const msgTokens = this.countMessageTokens(msg);
        if (usedTokens + msgTokens <= targetSpace) {
          safeMessages.splice(systemMessages.length, 0, msg);
          usedTokens += msgTokens;
        } else {
          break;
        }
      }
    } else if (truncationStrategy === TruncationStrategy.TRIM_FROM_END) {
      // 从末尾移除（保留最早）
      for (const msg of otherMessages) {
        const msgTokens = this.countMessageTokens(msg);
        if (usedTokens + msgTokens <= targetSpace) {
          safeMessages.push(msg);
          usedTokens += msgTokens;
        } else {
          break;
        }
      }
    } else if (truncationStrategy === TruncationStrategy.SMART_TRUNCATE) {
      // 智能截断：优先保留重要的消息
      // 简单实现：按消息长度排序，优先保留短消息（通常更精炼）
      const sortedMessages = [...otherMessages].sort(
        (a, b) => this.countTokens(a.content) - this.countTokens(b.content)
      );

      for (const msg of sortedMessages) {
        const msgTokens = this.countMessageTokens(msg);
        if (usedTokens + msgTokens <= targetSpace) {
          safeMessages.push(msg);
          usedTokens += msgTokens;
        } else {
          break;
        }
      }
    }

    return safeMessages;
  }

  /**
   * 分析token使用情况
   */
  analyzeUsage(messages: Message[]): UsageAnalysis {
    const totalTokens = this.calculateTotalInputTokens(messages);
    const maxAllowed = Math.floor(
      this.config.maxTotalTokens * (1 - this.config.safetyBufferRatio)
    );

    return {
      totalTokens,
      maxAllowed,
      usagePercentage: maxAllowed > 0 ? (totalTokens / maxAllowed) * 100 : 0,
      remainingTokens: Math.max(0, maxAllowed - totalTokens),
      needsTruncation: totalTokens > maxAllowed,
      modelConfig: { ...this.config },
    };
  }

  /**
   * 获取当前配置
   */
  getConfig(): ModelConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(newConfig: Partial<ModelConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * 导出配置为JSON字符串
   */
  exportConfig(): string {
    return JSON.stringify(this.config, null, 2);
  }
}

// ===================== 辅助函数 =====================

/**
 * 从JSON文件加载消息（Node.js环境）
 */
export async function loadMessagesFromFile(filePath: string): Promise<Message[]> {
  if (typeof window !== 'undefined') {
    throw new Error('loadMessagesFromFile仅支持Node.js环境');
  }

  const fs = await import('fs/promises');
  const data = JSON.parse(await fs.readFile(filePath, 'utf-8'));

  if (Array.isArray(data)) {
    return data;
  } else if (data && typeof data === 'object' && 'messages' in data) {
    return data.messages;
  } else {
    throw new Error('文件格式不正确，应为消息列表或包含messages键的对象');
  }
}

/**
 * 保存消息到JSON文件（Node.js环境）
 */
export async function saveMessagesToFile(
  filePath: string,
  messages: Message[]
): Promise<void> {
  if (typeof window !== 'undefined') {
    throw new Error('saveMessagesToFile仅支持Node.js环境');
  }

  const fs = await import('fs/promises');
  await fs.writeFile(
    filePath,
    JSON.stringify({ messages }, null, 2),
    'utf-8'
  );
}

/**
 * 创建模型配置文件
 */
export async function createConfigFile(
  modelName: string,
  configFile: string
): Promise<void> {
  if (typeof window !== 'undefined') {
    throw new Error('createConfigFile仅支持Node.js环境');
  }

  const config = MODEL_CONFIGS[modelName] || {
    name: modelName,
    maxTotalTokens: 32000,
    maxOutputTokens: 2000,
    tokenPerChar: 0.25,
    overheadPerMessage: 4,
    overheadSystem: 3,
    safetyBufferRatio: 0.10,
  };

  const fs = await import('fs/promises');
  await fs.writeFile(
    configFile,
    JSON.stringify(config, null, 2),
    'utf-8'
  );

  console.log(`配置文件已创建：${configFile}`);
}

// ===================== 快速集成示例 =====================

/**
 * 在Skill中快速集成的示例
 */
export async function exampleIntegration(): Promise<void> {
  // 1. 基本使用
  const messages: Message[] = [
    { role: "system", content: "你是一个助手" },
    { role: "user", content: "请解释量子计算" },
    { role: "assistant", content: "量子计算是利用..." },
    { role: "user", content: "再详细一点" },
  ];

  const manager = new TokenManager("deepseek-reasoner");
  const result = manager.protect(messages, 32000);

  console.log(`原始消息数: ${messages.length}`);
  console.log(`保护后消息数: ${result.messages.length}`);
  console.log(`安全max_tokens: ${result.maxTokens}`);

  // 2. 分析使用情况
  const analysis = manager.analyzeUsage(messages);
  console.log(`使用率: ${analysis.usagePercentage.toFixed(1)}%`);
  console.log(`需要截断: ${analysis.needsTruncation ? '是' : '否'}`);

  // 3. 在API调用中使用
  // const response = await callLlmApi({
  //   messages: result.messages,
  //   max_tokens: result.maxTokens,
  //   model: "deepseek-reasoner"
  // });
}

/**
 * 浏览器环境使用示例
 */
export function browserExample(): void {
  // 在浏览器中，通常从用户输入或本地存储获取消息
  const messages: Message[] = [
    { role: "user", content: "你好，请帮我写一首诗" },
  ];

  const manager = new TokenManager("gpt-3.5-turbo");
  const result = manager.protect(messages, 1000);

  console.log('保护完成:', result);
}

// ===================== 模块导出 =====================

// 默认导出TokenManager类
export default TokenManager;