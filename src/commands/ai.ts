import { invoke, isTauri } from '@tauri-apps/api/core';

export interface GenerateRequest {
  prompt: string;
  model: string;
  size: string;
  aspect_ratio: string;
  reference_images?: string[];
  extra_params?: Record<string, unknown>;
  enable_optimization?: boolean;
}

// Banana API 相关类型
export interface BananaLoginRequest {
  username: string;
  password: string;
}

export interface BananaLoginResponse {
  access_token: string;
  token_type: string;
  device_token: string;
  user_id: number;
  email: string;
  username: string;
  credits: number;
  /** 新用户注册后 API 配置尚未就绪，需要前端引导用户激活 */
  needs_activation: boolean;
}

export interface BananaUserInfo {
  user_id: number;
  username: string;
  email: string;
  is_active: boolean;
  is_account_active: boolean;
  credits: number;
}

export interface BananaCreditsInfo {
  credits: number;
}

export interface BananaPaymentOrder {
  order_id: string;
  payment_url: string;
  qr_code?: string;
  amount: number;
  credits: number;
}

export interface BananaPaymentStatus {
  order_id: string;
  status: string;
  paid: boolean;
  paid_at?: string;
}

export interface BananaApiConfig {
  id: number;
  api_name: string;
  api_type: string;
  api_url: string;
  api_key: string;
  curl_template?: string;
  is_active: boolean;
  supports_image_generation: boolean;
  supports_reference_image: boolean;
  default_image_width: number;
  default_image_height: number;
  max_image_size: number;
  image_quality: string;
  additional_params?: string;
  created_at: string;
  updated_at: string;
}

// 支付弹窗事件类型
export interface PaymentRequiredEvent {
  type?: 'payment' | 'recharge_guide';
  orderId: string;
  paymentUrl: string;
  amount: number;
  credits: number;
  qrCode?: string;
  title?: string;
  description?: string;
  userId?: string;
}

// 全局事件
declare global {
  interface WindowEventMap {
    'payment-required': CustomEvent<PaymentRequiredEvent>;
    'payment-success': CustomEvent<{ orderId: string }>;
    'payment-failed': CustomEvent<{ orderId: string; error: string }>;
    'login-required': CustomEvent;
    'skill-access-check': CustomEvent<{ resolve: (value: boolean) => void }>;
  }
}

export type GenerationJobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'not_found';

export interface GenerationJobStatus {
  job_id: string;
  status: GenerationJobState;
  result?: string | null;
  error?: string | null;
}

const BASE64_PREVIEW_HEAD = 96;
const BASE64_PREVIEW_TAIL = 24;

function truncateText(value: string, max = 200): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}...(${value.length} chars)`;
}

function truncateBase64Like(value: string): string {
  if (!value) {
    return value;
  }

  if (value.startsWith('data:')) {
    const [meta, payload = ''] = value.split(',', 2);
    if (payload.length <= BASE64_PREVIEW_HEAD + BASE64_PREVIEW_TAIL) {
      return value;
    }
    return `${meta},${payload.slice(0, BASE64_PREVIEW_HEAD)}...${payload.slice(-BASE64_PREVIEW_TAIL)}(${payload.length} chars)`;
  }

  const base64Like = /^[A-Za-z0-9+/=]+$/.test(value) && value.length > 256;
  if (!base64Like) {
    return truncateText(value, 280);
  }

  return `${value.slice(0, BASE64_PREVIEW_HEAD)}...${value.slice(-BASE64_PREVIEW_TAIL)}(${value.length} chars)`;
}

function sanitizeGenerateRequestForLog(request: GenerateRequest): Record<string, unknown> {
  return {
    prompt: truncateText(request.prompt, 240),
    model: request.model,
    size: request.size,
    aspect_ratio: request.aspect_ratio,
    reference_images_count: request.reference_images?.length ?? 0,
    reference_images_preview: (request.reference_images ?? []).map((item) =>
      truncateBase64Like(item)
    ),
    extra_params: request.extra_params ?? {},
  };
}

interface ErrorWithDetails extends Error {
  details?: string;
}

function normalizeInvokeError(error: unknown): { message: string; details?: string } {
  if (error instanceof Error) {
    const detailsText =
      'details' in error
        ? typeof (error as { details?: unknown }).details === 'string'
          ? (error as { details?: string }).details
          : undefined
        : undefined;
    return { message: error.message || 'Generation failed', details: detailsText };
  }

  if (typeof error === 'string') {
    return { message: error || 'Generation failed', details: error || undefined };
  }

  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const message =
      (typeof record.message === 'string' && record.message) ||
      (typeof record.error === 'string' && record.error) ||
      (typeof record.msg === 'string' && record.msg) ||
      'Generation failed';
    let details: string | undefined;
    try {
      details = truncateText(JSON.stringify(record, null, 2), 2000);
    } catch {
      details = truncateText(String(record), 2000);
    }
    return { message, details };
  }

  return { message: 'Generation failed' };
}

function createErrorWithDetails(message: string, details?: string): ErrorWithDetails {
  const error: ErrorWithDetails = new Error(message);
  if (details) {
    error.details = details;
  }
  return error;
}

export async function setApiKey(provider: string, apiKey: string): Promise<void> {
  console.info('[小鸭] set_api_key', {
    provider,
    apiKeyMasked: apiKey ? `${apiKey.slice(0, 4)}***${apiKey.slice(-2)}` : '',
    tauri: isTauri(),
  });
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境，请使用 `npm run tauri dev` 启动');
  }
  return await invoke('set_api_key', { provider, apiKey });
}

export async function originalGenerateImage(request: GenerateRequest): Promise<string> {
  // 原始实现：直接调用Rust的generate_image命令
  const startedAt = performance.now();
  console.info('[小鸭] generate_image request (原始实现)', {
    ...sanitizeGenerateRequestForLog(request),
    tauri: isTauri(),
  });

  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境，请使用 `npm run tauri dev` 启动');
  }

  try {
    const rawResult = await invoke<unknown>('generate_image', { request });
    if (typeof rawResult !== 'string') {
      throw createErrorWithDetails(
        'Generation returned non-string payload',
        truncateText(
          (() => {
            try {
              return JSON.stringify(rawResult, null, 2);
            } catch {
              return String(rawResult);
            }
          })(),
          2000
        )
      );
    }
    const result = rawResult.trim();
    if (!result) {
      throw createErrorWithDetails('Generation returned empty image source');
    }
    const elapsedMs = Math.round(performance.now() - startedAt);
    console.info('[小鸭] generate_image success', {
      elapsedMs,
      resultPreview: truncateText(result, 220),
    });
    return result;
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - startedAt);
    const normalizedError = normalizeInvokeError(error);
    console.error('[小鸭] generate_image failed', {
      elapsedMs,
      request: sanitizeGenerateRequestForLog(request),
      error,
      normalizedError,
    });
    const commandError: ErrorWithDetails = new Error(normalizedError.message);
    commandError.details = normalizedError.details;
    throw commandError;
  }
}

export async function submitGenerateImageJob(request: GenerateRequest): Promise<string> {
  console.info('[小鸭] submit_generate_image_job request (强制使用计费系统)', {
    ...sanitizeGenerateRequestForLog(request),
    tauri: isTauri(),
  });

  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境，请使用 `npm run tauri dev` 启动');
  }

  // 仅小鸭优化开启时额外扣 2 积分（与宫格扣 10 积分独立，互不干涉）
  if (request.enable_optimization) {
    try {
      await invoke<string>('banana_consume_credit', { count: 1 });
      console.info('[小鸭] 优化扣费成功 x2，现在提交实际的图像生成作业');
    } catch (error) {
      console.error('[小鸭] 优化扣费失败，阻止作业提交:', error);
      throw error;
    }
  }

  // 扣费成功后，提交实际的生成作业
  const jobId = await invoke<string>('submit_generate_image_job', { request });
  if (typeof jobId !== 'string' || !jobId.trim()) {
    throw new Error('submit_generate_image_job returned invalid job id');
  }
  return jobId.trim();
}

export async function getGenerateImageJob(jobId: string): Promise<GenerationJobStatus> {
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境，请使用 `npm run tauri dev` 启动');
  }

  const result = await invoke<GenerationJobStatus>('get_generate_image_job', { jobId });
  if (!result || typeof result !== 'object' || typeof result.status !== 'string') {
    throw new Error('get_generate_image_job returned invalid payload');
  }
  return result;
}

export async function listModels(): Promise<string[]> {
  return await invoke('list_models');
}

// ===================== Banana API 集成 =====================

/**
 * 初始化Banana API集成
 * @returns 如果已登录返回true，否则返回false
 */
export async function bananaInitialize(): Promise<boolean> {
  if (!isTauri()) {
    return false;
  }
  try {
    return await invoke<boolean>('banana_initialize');
  } catch (error) {
    console.warn('[Banana] 初始化失败:', error);
    return false;
  }
}

/**
 * 保存用户从 API 门户获取的设备令牌
 */
export async function bananaSaveDeviceToken(token: string): Promise<boolean> {
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境');
  }
  return await invoke<boolean>('banana_save_device_token', { token });
}

/**
 * 使用用户名密码登录Banana API
 */
export async function bananaLogin(username: string, password: string): Promise<BananaLoginResponse> {
  console.log('[Banana] 调用bananaLogin, username:', username);
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境');
  }
  try {
    const result = await invoke<BananaLoginResponse>('banana_login', { username, password });
    console.log('[Banana] bananaLogin成功, result:', result);
    return result;
  } catch (error) {
    console.error('[Banana] bananaLogin失败, error:', error);
    throw error;
  }
}

/**
 * 登出Banana API
 */
export async function bananaLogout(): Promise<void> {
  if (!isTauri()) {
    return;
  }
  await invoke('banana_logout');
}

/**
 * 获取当前用户信息
 */
export async function bananaGetCurrentUser(): Promise<BananaUserInfo> {
  console.log('[Banana] 调用bananaGetCurrentUser');
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境');
  }
  try {
    const result = await invoke<BananaUserInfo>('banana_get_current_user');
    console.log('[Banana] bananaGetCurrentUser成功, result:', result);
    return result;
  } catch (error) {
    console.error('[Banana] bananaGetCurrentUser失败, error:', error);
    throw error;
  }
}

/**
 * 检查剩余次数
 */
export async function bananaCheckCredits(): Promise<BananaCreditsInfo> {
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境');
  }
  return await invoke<BananaCreditsInfo>('banana_check_credits');
}

/**
 * 创建支付订单
 */
export async function bananaCreatePaymentOrder(
  userId: number,
  amount: number,
  credits: number,
  paymentMethod: string = 'alipay'
): Promise<BananaPaymentOrder> {
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境');
  }
  return await invoke<BananaPaymentOrder>('banana_create_payment_order', {
    userId,
    amount,
    credits,
    paymentMethod,
  });
}

/**
 * 检查支付状态
 */
export async function bananaCheckPaymentStatus(orderId: string): Promise<BananaPaymentStatus> {
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境');
  }
  return await invoke<BananaPaymentStatus>('banana_check_payment_status', { orderId });
}

/**
 * 获取充值兑换比例 (1元 = N积分)
 */
export async function bananaGetCreditsPerYuan(): Promise<number> {
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境');
  }
  return await invoke<number>('banana_get_credits_per_yuan');
}

/** 积分消费记录 */
export interface ConsumptionRecord {
  id: number;
  credits_consumed: number;
  credits_after: number;
  action_type: string;
  detail?: string;
  created_at: string;
}

/** 积分消费历史响应 */
export interface ConsumptionHistoryResponse {
  records: ConsumptionRecord[];
  total: number;
  page: number;
  limit: number;
}

/**
 * 获取积分消费记录
 */
export async function bananaGetConsumptionHistory(page = 1, limit = 20): Promise<ConsumptionHistoryResponse> {
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境');
  }
  return await invoke<ConsumptionHistoryResponse>('banana_get_consumption_history', { page, limit });
}

/**
 * 获取活动API配置
 */
export async function bananaGetActiveApiConfigs(): Promise<BananaApiConfig[]> {
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境');
  }
  return await invoke<BananaApiConfig[]>('banana_get_active_api_configs');
}

/**
 * 根据Banana API配置更新本地API密钥
 */
export async function bananaUpdateLocalApiKeys(configs: BananaApiConfig[]): Promise<void> {
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境');
  }
  await invoke('banana_update_local_api_keys', { apiConfigs: configs });
}

/**
 * 新用户账户激活：重试获取 API 配置并更新本地密钥
 */
export async function bananaActivateAccount(): Promise<void> {
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境');
  }
  await invoke('banana_activate_account');
}

/**
 * 前端退费：生成超时或网络错误时调用
 */
export async function bananaRefundCredits(credits: number, reason: string): Promise<string> {
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境');
  }
  return await invoke<string>('banana_refund_credits', { credits, reason });
}

/**
 * 手动刷新API配置
 */
export async function bananaRefreshApiConfigs(): Promise<BananaApiConfig[]> {
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境');
  }
  return await invoke<BananaApiConfig[]>('banana_refresh_api_configs');
}

/**
 * 发送密码重置验证码
 */
export async function bananaSendResetCode(email: string): Promise<{ msg: string }> {
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境');
  }
  return await invoke<{ msg: string }>('banana_send_reset_code', { email });
}

/**
 * 验证码重置密码
 */
export async function bananaResetPassword(
  email: string,
  code: string,
  newPassword: string
): Promise<{ msg: string }> {
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境');
  }
  return await invoke<{ msg: string }>('banana_reset_password', { email, code, newPassword });
}

/**
 * 清除所有本地API密钥
 */
export async function clearAllApiKeys(): Promise<void> {
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境');
  }
  await invoke('clear_all_api_keys');
}

/**
 * 注册Banana API用户
 */
export async function bananaRegister(
  username: string,
  email: string,
  password: string,
  referralCode?: string,
): Promise<BananaLoginResponse> {
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境');
  }
  return await invoke<BananaLoginResponse>('banana_register', {
    username,
    email,
    password,
    referralCode: referralCode || null,
  });
}

/**
 * 触发支付弹窗事件
 */
export function triggerPaymentRequired(order: BananaPaymentOrder & {
  type?: 'payment' | 'recharge_guide';
  title?: string;
  description?: string;
}): void {
  const event = new CustomEvent<PaymentRequiredEvent>('payment-required', {
    detail: {
      type: order.type,
      title: order.title,
      description: order.description,
      orderId: order.order_id,
      paymentUrl: order.payment_url,
      amount: order.amount,
      credits: order.credits,
      qrCode: order.qr_code,
    },
  });
  window.dispatchEvent(event);
}

/**
 * 触发登录弹窗事件
 */
export function triggerLoginRequired(): void {
  const event = new CustomEvent('login-required');
  window.dispatchEvent(event);
}

/**
 * 触发信用刷新事件
 */
export function triggerCreditsRefresh(): void {
  const event = new CustomEvent('credits-refresh');
  window.dispatchEvent(event);
}

/**
 * 通过Banana API生成图像（新版本）- 使用简化的计费通路
 */
export async function bananaGenerateImage(request: GenerateRequest): Promise<string> {
  const startedAt = performance.now();
  console.info('[Banana] generate_image request', {
    ...sanitizeGenerateRequestForLog(request),
    tauri: isTauri(),
  });

  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境，请使用 `npm run tauri dev` 启动');
  }

  try {
    // 调用新的计费通路
    const result = await invoke<string>('banana_call_image_api', {
      prompt: request.prompt,
      model: request.model,
      size: request.size,
      aspect_ratio: request.aspect_ratio,
      reference_images: request.reference_images,
      extra_params: request.extra_params,
    });

    const elapsedMs = Math.round(performance.now() - startedAt);
    console.info('[Banana] generate_image success', {
      elapsedMs,
      resultPreview: truncateText(result, 220),
    });

    // 触发信用刷新事件
    triggerCreditsRefresh();
    return result;
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - startedAt);
    const normalizedError = normalizeInvokeError(error);
    console.error('[Banana] generate_image failed', {
      elapsedMs,
      request: sanitizeGenerateRequestForLog(request),
      error,
      normalizedError,
    });

    // 检查是否为余额不足错误
    if (normalizedError.message.includes('INSUFFICIENT_CREDITS') ||
        normalizedError.message.includes('次数不足') ||
        normalizedError.message.includes('剩余次数不足')) {
      console.info('[Banana] 检测到次数不足错误，准备启动支付流程');

      // 触发支付流程并等待用户操作
      await handleInsufficientCredits();

      // 不再重试，让用户完成支付后再次手动尝试
      // 如果用户关闭了充值窗口，则直接抛出错误
      throw new Error('由于剩余次数不足，图像生成已暂停。请充值后重试。');
    }

    // 检查是否为未登录错误
    if (normalizedError.message.includes('设备令牌未找到') ||
        normalizedError.message.includes('未授权') ||
        normalizedError.message.includes('401')) {
      triggerLoginRequired();
      throw createErrorWithDetails('请先登录', '需要登录后才能使用小鸭生成功能');
    }

    const commandError: ErrorWithDetails = new Error(normalizedError.message);
    commandError.details = normalizedError.details;
    throw commandError;
  }
}

/**
 * 处理余额不足的情况
 */
async function handleInsufficientCredits(): Promise<void> {
  console.info('[小鸭] 积分不足，显示充值引导');

  try {
    const orderId = 'recharge-guide-' + Date.now().toString();
    triggerPaymentRequired({
      order_id: orderId,
      payment_url: '',
      amount: 0,
      credits: 0,
      type: 'recharge_guide',
      title: '积分不足',
      description: '',
    });
    console.info('[小鸭] 已显示充值引导');
  } catch (error) {
    console.error('[小鸭] 处理积分不足引导失败:', error);
    throw new Error('处理积分不足引导失败: ' + (error instanceof Error ? error.message : String(error)));
  }
}

/**
 * 检查是否已登录Banana API
 */
export async function isBananaLoggedIn(): Promise<boolean> {
  if (!isTauri()) {
    return false;
  }

  try {
    await bananaGetCurrentUser();
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * 仅使用Banana API进行图像生成（强制通过简化的计费系统）
 * 不会回退到原始实现，确保每次调用都经过计费
 */
export async function bananaOnlyGenerateImage(request: GenerateRequest): Promise<string> {
  // 检查是否已初始化Banana API
  const initialized = await bananaInitialize();

  if (!initialized) {
    console.info('[小鸭] 未初始化Banana API，需要先登录使用计费系统');
    triggerLoginRequired(); // 触发登录界面
    throw new Error('请先登录账号以使用小鸭生成功能（需要通过计费系统）');
  }

  try {
    console.info('[小鸭] 使用Banana API进行图像生成（将通过简化的计费系统）');
    return await bananaGenerateImage(request);
  } catch (error) {
    console.error('[小鸭] Banana API调用失败:', error);

    // 检查是否为认证相关的错误
    if (error instanceof Error) {
      if (error.message.includes('请先登录') ||
          error.message.includes('未授权') ||
          error.message.includes('401') ||
          error.message.includes('设备令牌') ||
          error.message.includes('INSUFFICIENT_CREDITS') ||
          error.message.includes('次数不足')) {
        // 这些错误表明需要登录或充值，触发相应界面
        if (error.message.includes('INSUFFICIENT_CREDITS') ||
            error.message.includes('次数不足')) {
          // 余额不足，触发支付
          await handleInsufficientCredits();
        } else {
          // 其他认证错误，触发登录
          triggerLoginRequired();
        }
        throw new Error('请先登录或充值以使用小鸭生成功能');
      }
    }

    // 抛出原始错误，不回退到非计费路径
    throw error;
  }
}

/**
 * 增强版的generateImage函数，优先使用Banana API
 * 如果Banana API不可用，则回退到原始实现
 */
export async function enhancedGenerateImage(request: GenerateRequest): Promise<string> {
  // 强制使用Banana API，确保经过计费系统
  return await bananaOnlyGenerateImage(request);
}

// 覆盖原始generateImage函数，使用增强版本
// 注意：这可能会破坏现有代码，根据实际情况决定是否启用
/**
 * 检查用户是否有权限使用技能
 * 验证登录状态和剩余次数
 */
export async function checkSkillPermission(): Promise<{ allowed: boolean; message: string; credits: number }> {
  if (!isTauri()) {
    return {
      allowed: false,
      message: '当前不是 Tauri 容器环境',
      credits: 0
    };
  }

  try {
    // 首先检查是否已登录
    const isLoggedIn = await isBananaLoggedIn();
    if (!isLoggedIn) {
      return {
        allowed: false,
        message: '请先登录小鸭中台账号',
        credits: 0
      };
    }

    // 获取用户信息和剩余次数
    const userInfo = await bananaGetCurrentUser();

    // 检查账户是否激活
    if (!userInfo.is_account_active) {
      return {
        allowed: false,
        message: '账户未激活，请充值后使用',
        credits: userInfo.credits
      };
    }

    // 检查剩余次数
    if (userInfo.credits <= 0) {
      return {
        allowed: false,
        message: '您的剩余次数为0，请充值后继续使用！费用包含分镜大师和小鸭分镜模型的总和费用!',
        credits: userInfo.credits
      };
    }

    // 用户已登录且次数充足
    return {
      allowed: true,
      message: '技能可以正常使用',
      credits: userInfo.credits
    };
  } catch (error) {
    console.error('[Skill Permission] 检查权限失败:', error);
    return {
      allowed: false,
      message: '权限检查失败，请检查网络连接或重新登录',
      credits: 0
    };
  }
}

export { enhancedGenerateImage as generateImage };

// ─── 跨设备同步 ───

export interface SyncStatus {
  state: 'idle' | 'syncing' | 'synced' | 'error';
  message: string;
  last_sync_time: number | null;
}

export async function syncPull(): Promise<SyncStatus> {
  return invoke<SyncStatus>('sync_pull');
}

export async function syncPush(): Promise<SyncStatus> {
  return invoke<SyncStatus>('sync_push');
}

export async function syncGetStatus(): Promise<SyncStatus> {
  return invoke<SyncStatus>('sync_get_status');
}

export async function syncForceFullPush(): Promise<SyncStatus> {
  return invoke<SyncStatus>('sync_force_full_push');
}

export async function syncExportSettings(settingsJson: string): Promise<void> {
  return invoke<void>('sync_export_settings', { settingsJson });
}

export async function syncImportSettings(): Promise<string> {
  return invoke<string>('sync_import_settings');
}

export async function syncTestQiniu(): Promise<string> {
  return invoke<string>('sync_test_qiniu');
}

export interface ConflictResolution {
  cloudId: string;
  action: 'overwrite' | 'keep_local';
}

export async function syncResolveConflicts(resolutions: ConflictResolution[]): Promise<SyncStatus> {
  return invoke<SyncStatus>('sync_resolve_conflicts', { resolutions });
}

// === 视频生成 ===

export interface VideoGenParams {
  prompt: string;
  aspectRatio: string;
  resolution?: string;
  durationSeconds: number;
  imageInput: string[];
  videoInput?: string[];
  model?: string;
  voiceUrl?: string;
  negativePrompt?: string;
  guidanceScale?: number;
  shotType?: string;
}

export interface VideoGenResult {
  success: boolean;
  taskId?: string;
  videoUrl?: string;
  creditsDeducted?: number;
  error?: string;
  requiredCredits?: number;
  currentCredits?: number;
}

export async function bananaSubmitVideoJob(params: VideoGenParams): Promise<VideoGenResult> {
  return invoke<VideoGenResult>('banana_submit_video_job', {
    prompt: params.prompt,
    aspectRatio: params.aspectRatio,
    resolution: params.resolution || '720P',
    durationSeconds: params.durationSeconds,
    imageInput: params.imageInput,
    videoInput: params.videoInput || null,
    model: params.model || null,
    voiceUrl: params.voiceUrl || null,
    negativePrompt: params.negativePrompt || null,
    guidanceScale: params.guidanceScale ?? null,
    shotType: params.shotType || null,
  });
}

export interface VideoPollResult {
  status: 'running' | 'succeeded' | 'failed' | 'retry';
  videoUrl?: string;
  error?: string;
  creditsRefunded?: boolean;
  creditsRetained?: boolean;
}

export async function bananaPollVideoJob(taskId: string, creditsDeducted?: number, model?: string): Promise<VideoPollResult> {
  return invoke<VideoPollResult>('banana_poll_video_job', {
    taskId,
    creditsDeducted: creditsDeducted ?? 0,
    model: model ?? null,
  });
}

export async function bananaGetActiveVideoModel(): Promise<string> {
  return invoke<string>('banana_get_active_video_model');
}

// ── Video Super-Resolution ──

export async function baiduUpscaleVideo(videoPath: string, resolution: '2K' | '4K'): Promise<string> {
  return invoke<string>('baidu_upscale_video', { videoPath, resolution });
}

interface UploadRefsResult {
  success: boolean;
  urls: string[];
  error?: string;
}

export async function bananaUploadRefImages(sources: string[]): Promise<UploadRefsResult> {
  return invoke<UploadRefsResult>('banana_upload_ref_images', { sources });
}

export interface UsageReportParams {
  api_type: string;
  is_success: boolean;
  cost_credits: number;
  response_time_ms: number;
  category: string;
  image_size: string;
  duration_seconds: number;
  prompt_len: number;
  error_message: string;
}

/** 上报用量到服务器（fire-and-forget） */
export async function bananaReportUsage(params: UsageReportParams): Promise<void> {
  try {
    const info = await bananaGetCurrentUser();
    console.log('[bananaReportUsage] user_id:', info.user_id);
    invoke('banana_report_usage', {
      userId: info.user_id,
      apiType: params.api_type,
      isSuccess: params.is_success,
      costCredits: params.cost_credits,
      responseTimeMs: params.response_time_ms,
      category: params.category,
      imageSize: params.image_size,
      durationSeconds: params.duration_seconds,
      promptLen: params.prompt_len,
      errorMessage: params.error_message,
    }).catch((e) => console.error('[bananaReportUsage] invoke failed:', e));
  } catch(e) {
    console.error('[bananaReportUsage] getCurrentUser failed:', e);
  }
}


