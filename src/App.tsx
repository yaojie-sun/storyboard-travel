import { useEffect, useState, useCallback } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Canvas } from './features/canvas/Canvas';
import { TitleBar } from './components/TitleBar';
import { SettingsDialog } from './components/SettingsDialog';
import { DistributionDashboard } from './components/DistributionDashboard';
import { UpdateAvailableDialog } from './components/UpdateAvailableDialog';
import { GlobalErrorDialog } from './components/GlobalErrorDialog';
import { LoginDialog } from './components/LoginDialog';
import { PaymentDialog } from './components/PaymentDialog';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ProjectManager, ProjectDashboard } from './features/project';
import { TokenActivationDialog } from './components/TokenActivationDialog';
import { VideoGenDialog } from './features/videoGeneration/VideoGenDialog';
import { initSyncOnLogin, SyncClosingOverlay } from './components/SyncStatus';
import { useThemeStore } from './stores/themeStore';
import { useProjectStore } from './stores/projectStore';
import { useChatStore } from './stores/chatStore';
import { useSettingsStore } from './stores/settingsStore';
import type { PaymentRequiredEvent, BananaUserInfo } from '@/commands/ai';
import { SyncConflictDialog } from './components/SyncConflictDialog';
import type { ProjectNameConflict, ConflictChoice } from './components/SyncConflictDialog';
import { AccountActivationDialog } from './components/AccountActivationDialog';
import { RestartReminderDialog } from './components/RestartReminderDialog';
import { syncResolveConflicts, syncPull } from './commands/ai';
import { hydrateVideoGenStore, useVideoGenStore } from './features/videoGeneration/videoGenStore';
import {
  bananaInitialize,
  bananaCheckCredits,
  bananaGetActiveApiConfigs,
  bananaUpdateLocalApiKeys,
  clearAllApiKeys,
  bananaLogout,
  isBananaLoggedIn,
  bananaGetCurrentUser,
} from '@/commands/ai';
import {
  subscribeOpenGlobalErrorDialog,
  type GlobalErrorDialogDetail,
} from './features/app/errorDialogEvents';
import { checkForUpdate } from './features/update/application/checkForUpdate';
import {
  subscribeOpenSettingsDialog,
  type SettingsCategory,
} from './features/settings/settingsEvents';

function toRgbCssValue(hexColor: string): string {
  const hex = hexColor.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    return '59 130 246';
  }
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  return `${r} ${g} ${b}`;
}

function App() {
  const { theme } = useThemeStore();
  const uiRadiusPreset = useSettingsStore((state) => state.uiRadiusPreset);
  const themeTonePreset = useSettingsStore((state) => state.themeTonePreset);
  const accentColor = useSettingsStore((state) => state.accentColor);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialCategory, setSettingsInitialCategory] = useState<SettingsCategory>('general');
  const [showDistribution, setShowDistribution] = useState(false);
  const [showUpdateDialog, setShowUpdateDialog] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<{
    latestVersion: string;
    currentVersion: string;
    downloadUrl: string;
    notes: string;
  } | null>(null);
  const [globalError, setGlobalError] = useState<GlobalErrorDialogDetail | null>(null);
  // Banana API 集成状态
  const [authStatus, setAuthStatus] = useState<'checking' | 'logged_in' | 'logged_out'>('logged_out'); // 默认未登录，立即显示登录窗口
  const [showLoginDialog, setShowLoginDialog] = useState(true); // 默认显示登录对话框
  const [showPaymentDialog, setShowPaymentDialog] = useState(false);
  const [paymentOrderInfo, setPaymentOrderInfo] = useState<PaymentRequiredEvent | null>(null);
  const [userInfo, setUserInfo] = useState<BananaUserInfo | null>(null);
  const [showTokenActivation, setShowTokenActivation] = useState(false);
  const [tokenActivationKey, setTokenActivationKey] = useState(0); // triggers re-init after activation
  const [syncClosing, setSyncClosing] = useState(false);
  const [syncConflicts, setSyncConflicts] = useState<ProjectNameConflict[]>([]);
  const [showAccountActivation, setShowAccountActivation] = useState(false);
  const [showRestartDialog, setShowRestartDialog] = useState(false);

  const isHydrated = useProjectStore((state) => state.isHydrated);
  const hydrate = useProjectStore((state) => state.hydrate);
  const currentProjectId = useProjectStore((state) => state.currentProjectId);
  const view = useProjectStore((state) => state.view);
  const closeProject = useProjectStore((state) => state.closeProject);
  const resetProjectStore = useProjectStore((state) => state.reset);
  const setView = useProjectStore((state) => state.setView);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.uiRadius = uiRadiusPreset;
  }, [uiRadiusPreset]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.themeTone = themeTonePreset;
  }, [themeTonePreset]);

  useEffect(() => {
    const root = document.documentElement;
    const isMac =
      typeof navigator !== 'undefined'
      && /(Mac|iPhone|iPad|iPod)/i.test(`${navigator.platform} ${navigator.userAgent}`);
    root.dataset.platform = isMac ? 'macos' : 'default';
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const normalized = accentColor.startsWith('#') ? accentColor : `#${accentColor}`;
    root.style.setProperty('--accent', normalized);
    root.style.setProperty('--accent-rgb', toRgbCssValue(normalized));
  }, [accentColor]);

  useEffect(() => {
    void hydrate();
    void useChatStore.getState().hydrate();
  }, [hydrate]);

  // 刷新/关闭前强制 flush 所有待保存数据（beforeunload 作为兜底）
  useEffect(() => {
    const handleBeforeUnload = () => {
      if ((window as any).__flushProjectPersists__) {
        (window as any).__flushProjectPersists__();
      }
      if ((window as any).__flushChatNow__) {
        (window as any).__flushChatNow__();
      }
      // 视频生成数据兜底：同步写 localStorage（Tauri 中 CloseRequested 已 await 落盘，此处为 secondary safety）
      if ((window as any).__videoGenStore) {
        try {
          const s = (window as any).__videoGenStore.getState();
          localStorage.setItem('storyboard-travel-videogen-configs', JSON.stringify({ configs: s.configs, history: s.history }));
        } catch {}
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  // Tauri 关闭事件：先 flush 所有数据（await 完成），再回调 Rust 退出进程
  useEffect(() => {
    const unlisten = listen('flush-before-close', async () => {
      // 异步 flush 聊天数据（await 确保落盘完成）
      if ((window as any).__flushChatNowAsync__) {
        await (window as any).__flushChatNowAsync__();
      } else if ((window as any).__flushChatNow__) {
        (window as any).__flushChatNow__();
      }
      // 异步 flush 项目数据并等待完成，确保 SQLite 事务提交
      if ((window as any).__flushProjectPersistsAndWait__) {
        await (window as any).__flushProjectPersistsAndWait__();
      }
      // 强制 flush 视频生成数据（500ms debounce 可能未触发）
      if ((window as any).__forcePersistVideoGenAsync__) {
        await (window as any).__forcePersistVideoGenAsync__();
      }
      // 通知 Rust 侧可以安全退出
      try {
        await invoke('confirm_close');
      } catch {
        // 如果 invoke 失败（进程可能已经在退出），忽略
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeOpenGlobalErrorDialog((detail) => {
      setGlobalError(detail);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeOpenSettingsDialog(({ category }) => {
      setSettingsInitialCategory(category ?? 'general');
      setShowSettings(true);
    });
    return unsubscribe;
  }, []);

  // Banana API 事件监听器
  useEffect(() => {
    const handlePaymentRequired = (event: CustomEvent<PaymentRequiredEvent>) => {
      setPaymentOrderInfo(event.detail);
      setShowPaymentDialog(true);
    };

    const handleLoginRequired = () => {
      console.log('收到login-required事件，用户需要重新登录');
      setAuthStatus('logged_out');
      setShowLoginDialog(true);
      setUserInfo(null);
    };

    const handleNetworkDown = (event: CustomEvent<string>) => {
      const msg = event.detail || '分镜大师无法连接服务器，已暂时退出登录。请检查网络后重试。';
      console.log('收到network-down事件:', msg);
      setAuthStatus('logged_out');
      setUserInfo(null);
      setGlobalError({ title: '网络故障', message: msg, details: '' });
    };

    // 添加处理信用刷新的事件
    const refreshCredits = async () => {
      console.log('刷新用户积分信息...');
      try {
        const updatedUserInfo = await bananaGetCurrentUser();
        setUserInfo(updatedUserInfo);
        console.log('用户积分刷新成功，当前剩余:', updatedUserInfo.credits);
      } catch (error) {
        console.error('刷新用户积分失败:', error);
      }
    };

    const handleCreditsRefresh = () => { void refreshCredits(); };

    // 添加处理技能访问权限检查的事件
    const handleSkillAccessCheck = async (event: CustomEvent<{ resolve: (value: boolean) => void }>) => {
      try {
        // 检查用户登录状态和剩余次数
        const isLoggedIn = await isBananaLoggedIn();

        if (!isLoggedIn) {
          // 如果未登录，触发登录对话框并返回false
          setAuthStatus('logged_out');
          setShowLoginDialog(true);
          event.detail.resolve(false);
          return;
        }

        // 如果已登录，检查剩余次数
        const userInfo = await bananaGetCurrentUser();
        if (userInfo.credits <= 0) {
          // 次数不足，显示充值引导
          setPaymentOrderInfo({
            type: 'recharge_guide',
            title: '次数不足',
            description: '您的剩余次数为0，请充值后继续使用！费用包含分镜大师和小鸭分镜模型的总和费用!',
            amount: 0,
            credits: 0,
            userId: userInfo?.user_id?.toString() || '',
            orderId: 'guide-' + Date.now(),
            paymentUrl: '',  // 添加必需的 paymentUrl 属性
          });
          setShowPaymentDialog(true);
          event.detail.resolve(false);
          return;
        }

        // 满足条件，允许访问
        event.detail.resolve(true);
      } catch (error) {
        console.error('技能访问权限检查失败:', error);
        event.detail.resolve(false);
      }
    };

    // 添加事件监听器
    window.addEventListener('payment-required', handlePaymentRequired);
    window.addEventListener('login-required', handleLoginRequired);
    window.addEventListener('network-down' as any, handleNetworkDown);
    window.addEventListener('credits-refresh', handleCreditsRefresh);

    // 添加技能访问检查事件监听器
    window.addEventListener('skill-access-check', handleSkillAccessCheck);

    // 应用关闭时同步提示
    const handleSyncClosing = () => setSyncClosing(true);
    window.addEventListener('sync:closing', handleSyncClosing);

    // 清理函数
    return () => {
      window.removeEventListener('payment-required', handlePaymentRequired);
      window.removeEventListener('login-required', handleLoginRequired);
      window.removeEventListener('network-down' as any, handleNetworkDown);
      window.removeEventListener('credits-refresh', handleCreditsRefresh);
      window.removeEventListener('skill-access-check', handleSkillAccessCheck);
      window.removeEventListener('sync:closing', handleSyncClosing);
    };
  }, []);

  // 启动时信用检查、API密钥更新和技能更新检查
  useEffect(() => {
    const initializeAppCreditsAndKeys = async () => {
      try {
        // 1. 初始化Banana API（检查本地是否有设备令牌）
        const initialized = await bananaInitialize();

        if (initialized) {
          // 已初始化，尝试获取当前用户信息以验证登录状态
          try {
            const userInfo = await bananaGetCurrentUser();

            // 用户信息获取成功，说明登录有效
            setAuthStatus('logged_in');
            setShowLoginDialog(false);
            setUserInfo(userInfo);

            // 设置当前用户 ID（用于 localStorage 数据隔离校验）
            useChatStore.getState().setCurrentUserId(String(userInfo.user_id));

            // hydrate() 在初始化完成前已调用失败（CURRENT_USER_ID 为空），
            // 此时 CURRENT_USER_ID 已在 bananaInitialize 中设置，可以重新加载
            void useProjectStore.getState().forceRehydrate();
            void useChatStore.getState().forceRehydrate();
            void hydrateVideoGenStore();

            // 导出本地设置到 Rust 侧（供退出时自动 push 到云端）
            initSyncOnLogin();

            // 2. 检查用户信用
            const credits = await bananaCheckCredits();

            if (credits.credits > 0) {
              // 3. 信用充足，获取活动API配置
              const activeConfigs = await bananaGetActiveApiConfigs();

              if (activeConfigs.length > 0) {
                // 4. 更新本地API密钥
                await bananaUpdateLocalApiKeys(activeConfigs);
                console.log('API密钥更新成功');

                // 5. 更新前端zustand store
                const settingsStore = useSettingsStore.getState();
                console.log('[DEBUG] 初始化: 更新前端store前，当前apiKeys:', settingsStore.apiKeys);
                console.log('[DEBUG] 初始化: 活动API配置数量:', activeConfigs.length);
                for (const config of activeConfigs) {
                  if (config.is_active && config.api_key) {
                    // 映射api_type到provider名称
                    let providerName = config.api_type.toLowerCase();
                    // 特殊映射
                    if (providerName === 'ppio') providerName = 'ppio';
                    else if (providerName === 'grsai') providerName = 'grsai';
                    else if (providerName === 'kie' || providerName === 'kie_image') providerName = 'kie';
                    else if (providerName === 'aliyun' || providerName === 'aliyun_image') providerName = 'kie';
                    else if (providerName === 'doubao_image') providerName = 'ppio';
                    else if (providerName === 'volcengine' || providerName === 'volcengine_image') providerName = 'volcengine';
                    else if (providerName === 'baidu' || providerName === 'baidu_image') providerName = 'baidu';
                    else {
                      console.warn(`未知的API类型: ${config.api_type}`);
                      continue;
                    }

                    settingsStore.setProviderApiKey(providerName, config.api_key);
                    console.log(`已更新前端store: ${providerName} API密钥`);
                    console.log('[DEBUG] 初始化: 更新后apiKeys:', settingsStore.apiKeys);
                  }
                }
              } else {
                console.warn('未找到活动API配置，显示激活弹窗');
                setShowAccountActivation(true);
                return;
              }
            } else {
              // 5. 信用不足，清除本地API密钥
              await clearAllApiKeys();
              console.warn('信用不足，已清除本地API密钥');

              // 提示用户充值（可以显示通知或触发支付对话框）
              console.log('请充值后继续使用');

              // 在这里显示充值提示
              // 创建虚拟订单信息用于显示充值引导
              setPaymentOrderInfo({
                type: 'recharge_guide',
                title: '次数不足',
                description: '您的剩余次数为0，请充值后继续使用！费用包含分镜大师和小鸭分镜模型的总和费用!',
                amount: 0,
                credits: 0,
                userId: userInfo?.user_id?.toString() || '',
                orderId: 'guide-' + Date.now(),
                paymentUrl: '',  // 添加必需的 paymentUrl 属性
              });
              setShowPaymentDialog(true);
            }
          } catch (userError) {
            // 获取用户信息失败，说明虽然初始化了但登录状态无效
            console.warn('登录状态验证失败，用户需要重新登录:', userError);
            setAuthStatus('logged_out');
            setShowLoginDialog(true);
            setUserInfo(null);
          }
        } else {
          // 未初始化：新用户默认显示登录/注册对话框
          setAuthStatus('logged_out');
          setShowLoginDialog(true);
          setShowTokenActivation(false);
          console.log('未初始化Banana API，显示登录对话框');
        }
      } catch (error) {
        console.error('启动初始化失败:', error);
        // 初始化失败：显示登录对话框
        setAuthStatus('logged_out');
        setShowLoginDialog(true);
        setShowTokenActivation(false);
        setUserInfo(null);
      }
    };

    // 在完成主要初始化后，检查技能更新
    const initializeWithSkillUpdate = async () => {
      // 先执行主要初始化
      await initializeAppCreditsAndKeys();

      // 然后检查技能更新 - 暂时注释掉以解决启动问题
      // try {
      //   console.log('[Seedance-T Updater] 检查技能更新...');
      //   await checkAndPerformSkillUpdate();
      // } catch (updateError) {
      //   console.error('[Seedance-T Updater] 检查技能更新时出错:', updateError);
      //   // 错误不应影响主要功能，继续执行
      // }
    };

    // 立即执行检查（但登录对话框已显示，不阻塞界面）
    void initializeWithSkillUpdate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenActivationKey]);

  // 定期检查登录状态（每60秒检查一次）
  useEffect(() => {
    if (authStatus !== 'logged_in') {
      // 如果当前不是登录状态，不进行定期检查
      return;
    }

    const CHECK_INTERVAL_MS = 60 * 1000; // 60秒
    let intervalId: number | null = null;

    const checkLoginStatus = async () => {
      try {
        const loggedIn = await isBananaLoggedIn();
        if (!loggedIn) {
          console.log('定期检查：用户已登出，显示登录对话框');
          // 用户已登出，更新状态并显示登录对话框
          setAuthStatus('logged_out');
          setShowLoginDialog(true);
          // 清除用户信息
          setUserInfo(null);
        }
      } catch (error) {
        console.error('定期检查登录状态失败:', error);
        // 检查失败也认为用户已登出
        setAuthStatus('logged_out');
        setShowLoginDialog(true);
        setUserInfo(null);
      }
    };

    // 立即执行一次检查
    void checkLoginStatus();

    // 设置定期检查
    intervalId = window.setInterval(checkLoginStatus, CHECK_INTERVAL_MS);

    return () => {
      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
    };
  }, [authStatus]);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | null = null;

    const notifyFrontendReady = async (attempt = 1) => {
      if (cancelled) {
        return;
      }

      try {
        await invoke('frontend_ready');
      } catch (error) {
        if (cancelled) {
          return;
        }

        if (attempt === 1 || attempt % 10 === 0) {
          console.warn('failed to notify frontend readiness', error);
        }

        const retryDelayMs = Math.min(500, 80 * attempt);
        retryTimer = window.setTimeout(() => {
          void notifyFrontendReady(attempt + 1);
        }, retryDelayMs);
      }
    };

    requestAnimationFrame(() => {
      void notifyFrontendReady();
    });

    return () => {
      cancelled = true;
      if (retryTimer) {
        window.clearTimeout(retryTimer);
      }
    };
  }, []);

  // 监听云端同步完成事件，自动刷新本地数据（强制，即使 isHydrated 为 true）
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlisten = await listen('sync-data-updated', () => {
          console.log('[App][DEBUG] sync-data-updated event received');
          // 云端同步完成，静默刷新本地项目列表
          // chat/conversations、settings、project 等文件被云端更新，需重新加载
          void useProjectStore.getState().forceRehydrate();
          void useChatStore.getState().forceRehydrate();
          // videogen_store: 重置 _hydrated 标记后重新 hydrate，确保云端数据被加载
          useVideoGenStore.setState({ _hydrated: false });
          void hydrateVideoGenStore();
        });
      } catch (e) {
        console.warn('[sync] 无法监听 sync-data-updated 事件:', e);
      }
    })();
    return () => { unlisten?.(); };
  }, []);

  // 监听云端同步项目名冲突事件
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlisten = await listen('sync-project-conflicts', (event) => {
          const conflicts = event.payload as ProjectNameConflict[];
          setSyncConflicts(conflicts);
        });
      } catch (e) {
        console.warn('[sync] 无法监听 sync-project-conflicts 事件:', e);
      }
    })();
    return () => { unlisten?.(); };
  }, []);

  useEffect(() => {
    if (!isHydrated) {
      return;
    }

    let cancelled = false;
    const runUpdateCheck = async () => {
      const result = await checkForUpdate();
      if (cancelled) {
        return;
      }
      if (result.hasUpdate && result.latestVersion && result.downloadUrl) {
        setUpdateInfo({
          latestVersion: result.latestVersion,
          currentVersion: result.currentVersion ?? '',
          downloadUrl: result.downloadUrl,
          notes: result.notes ?? '',
        });
        setShowUpdateDialog(true);
      }
    };

    void runUpdateCheck();
    return () => {
      cancelled = true;
    };
  }, [isHydrated]);

  // Banana API 回调函数
  const handleLoginSuccess = (user: BananaUserInfo, needsActivation?: boolean) => {
    console.log('登录成功:开始处理', user.email, 'needsActivation:', needsActivation);
    console.log('当前authStatus:', authStatus);
    console.log('当前isHydrated:', isHydrated);
    console.log('当前showLoginDialog:', showLoginDialog);

    // 可以在这里更新全局用户状态或显示通知
    setAuthStatus('logged_in');
    setShowLoginDialog(false);
    setUserInfo(user);

    console.log('状态已更新: authStatus=logged_in, showLoginDialog=false');

    // 设置当前用户 ID（用于 localStorage 数据隔离校验）
    useChatStore.getState().setCurrentUserId(String(user.user_id));

    // 重新加载本地数据（登出时已重置 store）
    void useProjectStore.getState().forceRehydrate();
    void useChatStore.getState().forceRehydrate();
    void hydrateVideoGenStore();

    // 如果服务端返回需要激活（新用户 API 配置未就绪），弹出重启提醒窗口
    if (needsActivation) {
      console.log('账户需要激活，显示重启提醒弹窗');
      setShowRestartDialog(true);
      return;
    }

    // 登录成功后检查信用并更新API密钥
    (async () => {
      try {
        // 1. 检查用户信用
        const credits = await bananaCheckCredits();
        console.log('用户剩余次数:', credits.credits);

        // 2. 无论积分多少，都获取并同步API密钥
        // 服务端扣费逻辑会拦截积分不足的请求，客户端不必清除密钥
        const activeConfigs = await bananaGetActiveApiConfigs();

        if (activeConfigs.length > 0) {
          await bananaUpdateLocalApiKeys(activeConfigs);
          console.log('API密钥更新成功');

          const settingsStore = useSettingsStore.getState();
          for (const config of activeConfigs) {
            if (config.is_active && config.api_key) {
              let providerName = config.api_type.toLowerCase();
              if (providerName === 'ppio') providerName = 'ppio';
              else if (providerName === 'grsai') providerName = 'grsai';
              else if (providerName === 'aliyun_image') providerName = 'ppio';
              else if (providerName === 'doubao_image') providerName = 'ppio';
              else if (providerName === 'volcengine' || providerName === 'volcengine_image') providerName = 'volcengine';
              else {
                console.warn(`未知的API类型: ${config.api_type}`);
                continue;
              }
              settingsStore.setProviderApiKey(providerName, config.api_key);
            }
          }
        } else {
          console.warn('未找到活动API配置，显示激活弹窗');
          setShowAccountActivation(true);
          return;
        }

        if (credits.credits <= 0) {
          console.warn('当前积分为0，AI生成功能将被服务端拦截，请充值或激活令牌');
        }
      } catch (error) {
        console.error('登录后初始化失败:', error);
        // 初始化失败不影响登录状态，但如果是配置问题则引导激活
        setShowAccountActivation(true);
      }

      // 导出本地设置到 Rust 侧（供退出时自动 push 到云端）
      initSyncOnLogin();
    })();
  };

  // 激活完成后：获取 API 配置并更新本地密钥
  const handleAccountActivated = async () => {
    console.log('账户激活完成，开始获取API配置');
    try {
      const credits = await bananaCheckCredits();
      console.log('用户剩余次数:', credits.credits);

      const activeConfigs = await bananaGetActiveApiConfigs();
      if (activeConfigs.length > 0) {
        await bananaUpdateLocalApiKeys(activeConfigs);
        const settingsStore = useSettingsStore.getState();
        for (const config of activeConfigs) {
          if (config.is_active && config.api_key) {
            let providerName = config.api_type.toLowerCase();
            if (providerName === 'ppio') providerName = 'ppio';
            else if (providerName === 'grsai') providerName = 'grsai';
            else if (providerName === 'kie' || providerName === 'kie_image') providerName = 'kie';
            else if (providerName === 'aliyun' || providerName === 'aliyun_image') providerName = 'kie';
            else if (providerName === 'doubao_image') providerName = 'ppio';
            else if (providerName === 'volcengine' || providerName === 'volcengine_image') providerName = 'volcengine';
            else if (providerName === 'baidu' || providerName === 'baidu_image') providerName = 'baidu';
            else {
              console.warn(`未知的API类型: ${config.api_type}`);
              continue;
            }
            settingsStore.setProviderApiKey(providerName, config.api_key);
          }
        }
        console.log('激活后API密钥更新成功');
      } else {
        console.warn('激活后仍未找到活动API配置');
      }
      initSyncOnLogin();
    } catch (error) {
      console.error('激活后初始化失败:', error);
    } finally {
      setShowAccountActivation(false);
    }
  };

  const handlePaymentSuccess = (orderId: string) => {
    console.log('支付成功:', orderId);
    // 支付成功后刷新用户次数或显示成功消息
    setShowPaymentDialog(false);
    setPaymentOrderInfo(null);
  };

  const handlePaymentFailed = (orderId: string, error: string) => {
    console.error('支付失败:', orderId, error);
    // 可以在这里显示错误消息或重试逻辑
    setShowPaymentDialog(false);
    setPaymentOrderInfo(null);
  };

  const handleLoginClose = () => {
    // 如果用户未登录，不允许关闭登录对话框
    if (authStatus === 'logged_out') {
      return;
    }
    setShowLoginDialog(false);
  };

  const handlePaymentClose = () => {
    setShowPaymentDialog(false);
    setPaymentOrderInfo(null);
  };

  // 导航返回：Canvas → Dashboard, Dashboard → Manager
  const handleBack = useCallback(() => {
    if (view === 'canvas') {
      setView('dashboard');
    } else {
      closeProject();
    }
  }, [view, setView, closeProject]);

  // 退出登录处理函数
  const handleLogout = async () => {
    // 先关闭当前项目（保存画布状态到数据库）
    if (currentProjectId) {
      closeProject();
    }

    // 强制 flush 所有待保存的 chat 数据到磁盘
    if ((window as any).__flushChatNowAsync__) {
      await (window as any).__flushChatNowAsync__();
    }
    // 强制 flush video gen 数据（防止 debounce 未触发的保存丢失）
    if ((window as any).__forcePersistVideoGenAsync__) {
      await (window as any).__forcePersistVideoGenAsync__();
    }

    try {
      // 调用Rust后端登出命令
      await bananaLogout();
      console.log('用户已退出登录');
    } catch (error) {
      console.error('退出登录失败:', error);
    } finally {
      // 清除项目列表和状态，重置 isHydrated 以便下次登录重新加载
      resetProjectStore();
      // 清除聊天记录（内存 + localStorage，防止下一个用户看到上一个用户的对话）
      useChatStore.setState({ conversations: [], activeConversationId: null, hydrated: false, currentUserId: '' });
      try { localStorage.removeItem('storyboard-chat-conversations'); } catch {}
      // 清除视频生成数据（防止下一用户看到上一用户的视频记录）
      useVideoGenStore.getState().reset();
      // 清除用户状态
      setAuthStatus('logged_out');
      setUserInfo(null);
      setShowLoginDialog(true);
      setShowSettings(false);
    }
  };

  // 刷新次数处理函数
  const handleRefreshCredits = async () => {
    try {
      // 调用检查信用API
      const credits = await bananaCheckCredits();
      console.log('刷新次数成功:', credits.credits);

      // 更新用户信息
      if (userInfo) {
        setUserInfo({
          ...userInfo,
          credits: credits.credits,
        });
      }
    } catch (error) {
      console.error('刷新次数失败:', error);
    }
  };

  // 处理"去登录"按钮
  const handleGoToLogin = () => {
    setShowSettings(false); // 关闭设置对话框
    setShowLoginDialog(true); // 打开登录对话框
  };

  // 令牌激活成功，重新初始化
  const handleTokenActivated = () => {
    setShowTokenActivation(false);
    setTokenActivationKey((prev) => prev + 1); // trigger re-init
  };

  // 从令牌激活切换到账号密码登录
  const handleSwitchToLogin = () => {
    setShowTokenActivation(false);
    setShowLoginDialog(true);
  };

  // 从登录切换到令牌激活
  const handleSwitchToToken = () => {
    setShowLoginDialog(false);
    setShowTokenActivation(true);
  };

  // 如果应用状态未加载完成，但用户已登录，显示主界面但提示加载状态
  if (!isHydrated) {
    // 如果未登录，始终显示登录对话框或令牌激活对话框
    if (authStatus === 'logged_out' || authStatus === 'checking') {
      return (
        <ReactFlowProvider>
          <div className="w-full h-full bg-bg-dark flex items-center justify-center">
            {/* 背景模糊层 */}
            <div className="absolute inset-0 bg-bg-dark/95 backdrop-blur-sm" />
            {/* 令牌激活或登录对话框居中 */}
            <div className="relative z-10">
              {showTokenActivation ? (
                <TokenActivationDialog
                  isOpen={true}
                  onActivated={handleTokenActivated}
                  onSwitchToLogin={handleSwitchToLogin}
                />
              ) : (
                <LoginDialog
                  isOpen={true}
                  onClose={handleLoginClose}
                  onLoginSuccess={handleLoginSuccess}
                  onSwitchToToken={handleSwitchToToken}
                />
              )}
            </div>
          </div>
        </ReactFlowProvider>
      );
    }
    // 如果已登录，显示主界面但带有加载覆盖层
    // 这样可以避免用户卡在无限加载状态
    return (
      <ReactFlowProvider>
        <div className="w-full h-full flex flex-col bg-bg-dark">
          {/* 加载覆盖层 */}
          <div className="absolute inset-0 bg-bg-dark/80 backdrop-blur-sm z-40 flex items-center justify-center">
            <div className="text-text-muted text-sm">正在加载项目数据...</div>
          </div>

          <TitleBar
            onSettingsClick={() => {
              setSettingsInitialCategory('general');
              setShowSettings(true);
            }}
            showBackButton={!!currentProjectId}
            onBackClick={handleBack}
          />

          <main className="flex-1 relative min-h-0">
            <ErrorBoundary>
              {view === 'canvas' ? <Canvas /> : view === 'dashboard' ? <ProjectDashboard /> : <ProjectManager />}
            </ErrorBoundary>
          </main>

          <SettingsDialog
            isOpen={showSettings}
            onClose={() => setShowSettings(false)}
            initialCategory={settingsInitialCategory}
            userInfo={userInfo}
            onLogout={handleLogout}
            onRefreshCredits={handleRefreshCredits}
            onGoToLogin={handleGoToLogin}
            onOpenDistribution={() => setShowDistribution(true)}
          />
          <DistributionDashboard
            isOpen={showDistribution}
            onClose={() => setShowDistribution(false)}
          />
          <UpdateAvailableDialog
            isOpen={showUpdateDialog}
            onClose={() => setShowUpdateDialog(false)}
            latestVersion={updateInfo?.latestVersion}
            currentVersion={updateInfo?.currentVersion}
            downloadUrl={updateInfo?.downloadUrl}
            notes={updateInfo?.notes}
          />
          <GlobalErrorDialog
            isOpen={Boolean(globalError)}
            title={globalError?.title ?? ''}
            message={globalError?.message ?? ''}
            details={globalError?.details}
            copyText={globalError?.copyText}
            onClose={() => setGlobalError(null)}
          />
          <LoginDialog
            isOpen={showLoginDialog}
            onClose={handleLoginClose}
            onLoginSuccess={handleLoginSuccess}
            onSwitchToToken={handleSwitchToToken}
          />
          <AccountActivationDialog
            isOpen={showAccountActivation}
            onActivated={handleAccountActivated}
          />
          <RestartReminderDialog
            isOpen={showRestartDialog}
          />
          <PaymentDialog
            isOpen={showPaymentDialog && paymentOrderInfo !== null}
            orderId={paymentOrderInfo?.orderId || ''}
            type={paymentOrderInfo?.type}
            title={paymentOrderInfo?.title}
            description={paymentOrderInfo?.description}
            paymentUrl={paymentOrderInfo?.paymentUrl || ''}
            amount={paymentOrderInfo?.amount || 0}
            credits={paymentOrderInfo?.credits || 0}
            qrCode={paymentOrderInfo?.qrCode}
            onPaymentSuccess={handlePaymentSuccess}
            onPaymentFailed={handlePaymentFailed}
            onClose={handlePaymentClose}
            onRecharged={async () => { try { const u = await bananaGetCurrentUser(); setUserInfo(u); } catch {} }}
          />
        </div>
      </ReactFlowProvider>
    );
  }

  // 检查认证状态
  // if (authStatus === 'checking') {
  //   return (
  //     <ReactFlowProvider>
  //       <div className="w-full h-full bg-bg-dark flex items-center justify-center">
  //         <div className="text-text-muted text-sm">检查登录状态...</div>
  //       </div>
  //     </ReactFlowProvider>
  //   );
  // }

  if (authStatus === 'logged_out' || authStatus === 'checking') {
    // 未登录状态：只显示登录对话框，锁定界面
    return (
      <ReactFlowProvider>
        <div className="w-full h-full bg-bg-dark flex items-center justify-center">
          {/* 背景模糊层 */}
          <div className="absolute inset-0 bg-bg-dark/95 backdrop-blur-sm" />
          {/* 登录对话框居中 */}
          <div className="relative z-10">
            <LoginDialog
              isOpen={true}
              onClose={handleLoginClose}
              onLoginSuccess={handleLoginSuccess}
              onSwitchToToken={handleSwitchToToken}
            />
          </div>
          {/* 仍然渲染全局错误对话框，以防需要显示错误 */}
          <GlobalErrorDialog
            isOpen={Boolean(globalError)}
            title={globalError?.title ?? ''}
            message={globalError?.message ?? ''}
            details={globalError?.details}
            copyText={globalError?.copyText}
            onClose={() => setGlobalError(null)}
          />
        </div>
      </ReactFlowProvider>
    );
  }

  // 已登录状态：显示完整的主界面
  return (
    <ReactFlowProvider>
      <div className="w-full h-full flex flex-col bg-bg-dark">
        <TitleBar
          onSettingsClick={() => {
            setSettingsInitialCategory('general');
            setShowSettings(true);
          }}
          showBackButton={!!currentProjectId}
          onBackClick={handleBack}
        />

        <main className="flex-1 relative min-h-0">
          <ErrorBoundary>
            {view === 'canvas' ? <Canvas /> : view === 'dashboard' ? <ProjectDashboard /> : <ProjectManager />}
          </ErrorBoundary>
        </main>

        <SettingsDialog
          isOpen={showSettings}
          onClose={() => setShowSettings(false)}
          initialCategory={settingsInitialCategory}
          userInfo={userInfo}
          onLogout={handleLogout}
          onRefreshCredits={handleRefreshCredits}
          onGoToLogin={handleGoToLogin}
          onOpenDistribution={() => setShowDistribution(true)}
        />
        <DistributionDashboard
          isOpen={showDistribution}
          onClose={() => setShowDistribution(false)}
        />
        <UpdateAvailableDialog
          isOpen={showUpdateDialog}
          onClose={() => setShowUpdateDialog(false)}
          latestVersion={updateInfo?.latestVersion}
          currentVersion={updateInfo?.currentVersion}
          downloadUrl={updateInfo?.downloadUrl}
          notes={updateInfo?.notes}
        />
        <GlobalErrorDialog
          isOpen={Boolean(globalError)}
          title={globalError?.title ?? ''}
          message={globalError?.message ?? ''}
          details={globalError?.details}
          copyText={globalError?.copyText}
          onClose={() => setGlobalError(null)}
        />
        <TokenActivationDialog
          isOpen={showTokenActivation}
          onActivated={handleTokenActivated}
        />
        <LoginDialog
          isOpen={showLoginDialog}
          onClose={handleLoginClose}
          onLoginSuccess={handleLoginSuccess}
          onSwitchToToken={handleSwitchToToken}
        />
        <PaymentDialog
          isOpen={showPaymentDialog && paymentOrderInfo !== null}
          orderId={paymentOrderInfo?.orderId || ''}
          type={paymentOrderInfo?.type}
          title={paymentOrderInfo?.title}
          description={paymentOrderInfo?.description}
          paymentUrl={paymentOrderInfo?.paymentUrl || ''}
          amount={paymentOrderInfo?.amount || 0}
          credits={paymentOrderInfo?.credits || 0}
          qrCode={paymentOrderInfo?.qrCode}
          onPaymentSuccess={handlePaymentSuccess}
          onPaymentFailed={handlePaymentFailed}
          onClose={handlePaymentClose}
          onRecharged={async () => { try { const u = await bananaGetCurrentUser(); setUserInfo(u); } catch {} }}
        />
        <SyncClosingOverlay visible={syncClosing} />
        <SyncConflictDialog
          isOpen={syncConflicts.length > 0}
          conflicts={syncConflicts}
          onConfirm={async (choices: ConflictChoice[]) => {
            setSyncConflicts([]);
            try {
              await syncResolveConflicts(choices);
              // 二次拉取：下载冲突解决时跳过的剩余资源（图片/视频/聊天等）
              await syncPull();
              void useProjectStore.getState().forceRehydrate();
              void useChatStore.getState().forceRehydrate();
              void hydrateVideoGenStore();
            } catch (e) {
              console.error('[sync] 冲突解决失败:', e);
            }
          }}
          onCancel={() => setSyncConflicts([])}
        />
        <VideoGenDialog />
      </div>
    </ReactFlowProvider>
  );
}

export default App;
