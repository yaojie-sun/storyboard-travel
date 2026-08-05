import { useState } from 'react';
import { UiButton, UiCheckbox, UiInput, UiModal } from '@/components/ui';
import { useTranslation } from 'react-i18next';
import { bananaLogin, bananaRegister, bananaGetCurrentUser, bananaSendResetCode, bananaResetPassword } from '@/commands/ai';
import type { BananaUserInfo } from '@/commands/ai';

const USER_NOTICE_CONTENT = `用户须知
欢迎您使用小鸭分镜大师提供的提示词创作与 AI 生成服务（以下简称 "本服务"）。在注册账号并使用本服务前，请您仔细阅读并充分理解本须知的全部条款。您点击 "同意并注册" 按钮，即表示您已阅读、理解并同意接受本须知所有条款的约束。如您不同意本须知的任何内容，请立即停止注册并放弃使用本服务。
一、服务说明
小鸭分镜大师是一款专业的提示词创作与 AI 生成辅助工具，通过接入经合法授权的第三方人工智能技术服务，为用户提供视频提示词生成、分镜图像生成、视频内容生成等相关服务。
本服务仅为用户提供技术工具支持，所有通过本服务生成的内容均由用户输入的提示词及相关参数决定，小鸭分镜大师不对生成内容的创意、质量、准确性及适用性承担任何保证责任。
我们有权根据技术发展、业务调整及法律法规要求，随时变更、暂停、终止部分或全部服务内容，变更前将通过软件内公告等合理方式通知用户。
二、用户账号管理
您应当通过真实、准确、完整的信息注册小鸭分镜大师账号，并对账号下的所有行为承担全部法律责任。
您有义务妥善保管账号及密码，不得将账号转借、出租、出售给他人使用。因您保管不善或授权他人使用导致的任何损失，由您自行承担。
如发现账号被盗用或存在异常使用情况，请立即联系我们的客服处理。我们将在合理范围内协助您解决问题，但不对因此产生的损失承担责任。
三、用户使用规范
您在使用本服务过程中，必须严格遵守国家法律法规、社会公序良俗及本须知约定，不得制作、复制、传播或生成含有以下内容的任何材料：
反对中华人民共和国宪法确定的基本原则，危害国家统一、主权和领土完整，泄露国家秘密，危害国家安全，损害国家荣誉和利益的内容；
宣扬恐怖主义、极端主义、民族仇恨、民族歧视，破坏民族团结的内容；
宣扬邪教、封建迷信，扰乱社会秩序，破坏社会稳定的内容；
散布淫秽、色情、赌博、暴力、凶杀、恐怖或者教唆犯罪的内容；
侮辱或者诽谤他人，侵害他人名誉权、肖像权、隐私权、知识产权等合法权益的内容；
伪造、变造虚假信息，误导、欺骗他人的内容；
侵犯未成年人合法权益或者损害未成年人身心健康的内容；
其他违反法律法规、公序良俗或小鸭分镜大师规定的内容。
您进一步承诺：
不得利用本服务从事任何违法犯罪活动或为违法犯罪活动提供便利；
不得恶意批量注册账号、恶意刷取服务资源或进行其他任何破坏本服务正常运行的行为；
不得对小鸭分镜大师进行反向工程、反编译、破解或以其他方式试图获取本软件的源代码；
不得将本服务生成的内容用于任何可能对社会公共利益造成损害或侵犯他人合法权益的用途。
四、知识产权声明
小鸭分镜大师的全部知识产权（包括但不限于著作权、商标权、专利权、商业秘密等）归本软件运营方所有。未经书面授权，您不得复制、传播、修改、改编本软件的任何部分或利用本软件进行任何商业活动。
您对自己通过本服务生成的内容享有合法权益，但您应当保证所输入的提示词及相关素材不侵犯任何第三方的知识产权及其他合法权益。
您理解并同意，人工智能生成内容可能存在与现有作品相似或巧合的情况。因您使用生成内容而引发的任何知识产权纠纷，由您自行承担全部责任，与小鸭分镜大师无关。
为了改进和优化本服务，我们有权在匿名化、去标识化的前提下，使用您的使用数据及生成内容用于模型训练和技术研发。
五、免责声明
本服务按 "现状" 和 "可获得" 的状态提供，我们不做任何明示或暗示的保证，包括但不限于对服务的准确性、完整性、可靠性、适用性、无错误、不间断运行的保证。
因不可抗力（包括但不限于自然灾害、战争、政府行为）、第三方服务故障、网络攻击、系统维护等不可归责于我们的原因导致的服务中断、数据丢失或其他损失，我们不承担任何责任。
您使用本服务生成的任何内容所产生的一切法律后果，均由您自行承担。我们不对任何因使用生成内容而导致的直接或间接损失承担责任。
我们有权对用户提交的内容进行审核，对于违反本须知或法律法规的内容，有权立即删除并采取包括但不限于限制账号功能、冻结账号、永久封禁账号等措施，且无需向用户承担任何责任。
六、隐私保护
我们严格遵守《中华人民共和国个人信息保护法》等相关法律法规，保护您的个人信息安全。
我们仅收集为提供服务所必需的个人信息，并按照小鸭分镜大师《隐私政策》的约定处理和保护您的个人信息。您可以在软件内查看完整的《隐私政策》。
未经您的同意，我们不会向任何第三方提供、出售、出租您的个人信息，但法律法规另有规定或为保护公共利益所必需的除外。
七、服务终止
如您违反本须知的任何条款，我们有权随时终止向您提供服务，且无需退还任何已支付的费用。
您可以随时申请注销您的小鸭分镜大师账号。账号注销后，您将无法继续使用本服务，账号内的所有数据将被删除且无法恢复。
服务终止后，本须知中关于知识产权、免责声明、争议解决等条款仍然有效。
八、其他条款
本须知的订立、执行和解释均适用中华人民共和国法律。
如本须知的任何条款被认定为无效或不可执行，不影响其他条款的法律效力。
我们有权根据法律法规变化及业务发展需要，随时修改本须知。修改后的须知将在小鸭分镜大师软件内公布，自公布之日起生效。您继续使用本服务即表示您同意接受修改后的须知条款。
因本须知引起的或与本须知有关的任何争议，双方应首先通过友好协商解决；协商不成的，任何一方均有权向本软件运营方所在地有管辖权的人民法院提起诉讼。
再次提醒：请您在使用小鸭分镜大师前仔细阅读本须知，确保您理解并同意所有条款。如有任何疑问，请联系我们的客服团队。`;

interface LoginDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onLoginSuccess: (user: BananaUserInfo, needsActivation?: boolean) => void;
  onSwitchToToken?: () => void;
}

export function LoginDialog({ isOpen, onClose, onLoginSuccess, onSwitchToToken }: LoginDialogProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'login' | 'register' | 'forgotPassword'>('login');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isCheckingLogin] = useState(false);
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [showNotice, setShowNotice] = useState(false);

  // 忘记密码状态
  const [resetStep, setResetStep] = useState<1 | 2>(1);
  const [resetCode, setResetCode] = useState('');
  const [countdown, setCountdown] = useState(0);

  // 注释掉自动检查登录状态，由App.tsx处理
  // useEffect(() => {
  //   const checkLoginStatus = async () => {
  //     if (!isOpen) return;
  //
  //     setIsCheckingLogin(true);
  //     try {
  //       await bananaInitialize();
  //       const loggedIn = await isBananaLoggedIn();
  //       if (loggedIn) {
  //         const user = await bananaGetCurrentUser();
  //         onLoginSuccess(user);
  //         onClose();
  //       }
  //     } catch (error) {
  //       console.warn('检查登录状态失败:', error);
  //     } finally {
  //       setIsCheckingLogin(false);
  //     }
  //   };
  //
  //   checkLoginStatus();
  // }, [isOpen, onClose, onLoginSuccess]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // 验证输入
    if (!username.trim()) {
      setError(t('loginDialog.pleaseEnterUsername', '请输入用户名'));
      return;
    }

    if (mode === 'register' && username.trim().length < 3) {
      setError(t('loginDialog.usernameTooShort', '用户名至少需要3个字符'));
      return;
    }

    if (!password.trim()) {
      setError(t('loginDialog.pleaseEnterPassword', '请输入密码'));
      return;
    }

    if (mode === 'register') {
      if (!email.trim()) {
        setError(t('loginDialog.pleaseEnterEmail', '请输入邮箱'));
        return;
      }

      if (password !== confirmPassword) {
        setError(t('loginDialog.passwordsNotMatch', '两次输入的密码不一致'));
        return;
      }

      if (!agreedToTerms) {
        setError(t('loginDialog.mustAgreeToTerms', '请先阅读并同意《用户须知》'));
        return;
      }
    }

    setIsLoading(true);
    setError(null);

    console.log('开始登录/注册，模式:', mode, '用户名:', username);
    try {
      // 添加超时处理，防止请求无限等待
      const TIMEOUT_MS = 15000; // 15秒超时

      let userInfo: BananaUserInfo;
      let needsActivation = false;

      if (mode === 'login') {
        // 登录模式
        console.log('调用bananaLogin');
        const loginPromise = bananaLogin(username, password);
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('登录请求超时，请检查网络连接')), TIMEOUT_MS);
        });
        const loginResult = await Promise.race([loginPromise, timeoutPromise]);
        console.log('bananaLogin成功，结果:', loginResult);
        needsActivation = loginResult.needs_activation ?? false;

        // 尝试获取完整的用户信息，如果失败则使用登录响应中的基本信息
        try {
          console.log('调用bananaGetCurrentUser获取完整用户信息');
          const fullUserInfo = await bananaGetCurrentUser();
          console.log('bananaGetCurrentUser成功，用户信息:', fullUserInfo);
          userInfo = fullUserInfo;
        } catch (error) {
          console.warn('获取完整用户信息失败，使用登录响应中的基本信息:', error);
          // 使用登录响应中的基本信息创建用户信息对象
          userInfo = {
            user_id: loginResult.user_id,
            username: loginResult.username,
            email: loginResult.email,
            is_active: true,
            is_account_active: true,
            credits: loginResult.credits,
          };
        }
      } else {
        // 注册模式
        console.log('调用bananaRegister');
        const registerPromise = bananaRegister(username, email, password);
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('注册请求超时，请检查网络连接')), TIMEOUT_MS);
        });
        const registerResult = await Promise.race([registerPromise, timeoutPromise]);
        console.log('bananaRegister成功，结果:', registerResult);
        needsActivation = registerResult.needs_activation ?? false;

        // 注册后自动登录，使用注册返回的信息
        userInfo = {
          user_id: registerResult.user_id,
          username: registerResult.username,
          email: registerResult.email,
          is_active: true,
          is_account_active: true,
          credits: registerResult.credits,
        };
      }

      // 在调用onLoginSuccess之前设置isLoading为false，避免组件卸载后状态更新被忽略
      setIsLoading(false);
      console.log('登录成功，调用onLoginSuccess回调，用户信息:', userInfo, 'needsActivation:', needsActivation);
      onLoginSuccess(userInfo, needsActivation);
      // 成功完成后立即返回，避免finally块再次设置isLoading状态
      return;
      // 注意：不要调用onClose()，由父组件的handleLoginSuccess处理对话框关闭
      // onClose();
    } catch (error) {
      console.error(mode === 'login' ? '登录失败:' : '注册失败:', error);
      console.error('完整错误对象:', error);
      let errorMessage = '';
      if (error instanceof Error) {
        errorMessage = error.message;
        console.error('错误栈:', error.stack);
      } else if (typeof error === 'string') {
        errorMessage = error;
      } else if (error && typeof error === 'object') {
        // Try to extract message from error object
        errorMessage = (error as any).message || JSON.stringify(error);
        console.error('错误详情:', error);
      } else {
        errorMessage = mode === 'login'
          ? t('loginDialog.loginFailed', '登录失败，请检查用户名和密码')
          : t('loginDialog.registerFailed', '注册失败，请检查输入信息');
      }
      // 显示完整错误信息，包括类型
      const fullErrorMessage = `登录失败: ${errorMessage} (原始错误: ${String(error)})`;
      console.error('完整错误消息:', fullErrorMessage);
      setError(fullErrorMessage);
    } finally {
      console.log('登录流程结束，设置isLoading为false');
      setIsLoading(false);
    }
  };

  const resetForm = () => {
    setUsername('');
    setEmail('');
    setPassword('');
    setConfirmPassword('');
    setError(null);
    setResetStep(1);
    setResetCode('');
    setCountdown(0);
    setAgreedToTerms(false);
  };

  const handleClose = () => {
    setMode('login');
    resetForm();
    onClose();
  };

  const handleSendResetCode = async () => {
    if (!email.trim()) {
      setError(t('loginDialog.pleaseEnterEmail', '请输入邮箱'));
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      await bananaSendResetCode(email.trim());
      setError(null);
      setResetStep(2);
    } catch (err: any) {
      setError(err?.message || t('loginDialog.resetPasswordFailed', '发送失败'));
      return;
    } finally {
      setIsLoading(false);
    }
    // 启动60秒倒计时
    setCountdown(60);
    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const handleResetPassword = async () => {
    if (!resetCode.trim() || resetCode.trim().length !== 6) {
      setError(t('loginDialog.codePlaceholder', '请输入6位验证码'));
      return;
    }
    if (!password.trim()) {
      setError(t('loginDialog.pleaseEnterPassword', '请输入密码'));
      return;
    }
    if (password !== confirmPassword) {
      setError(t('loginDialog.passwordsNotMatch', '两次输入的密码不一致'));
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      await bananaResetPassword(email.trim(), resetCode.trim(), password);
      setError(null);
      alert(t('loginDialog.resetPasswordSuccess', '密码重置成功，请登录'));
      setMode('login');
      resetForm();
    } catch (err: any) {
      setError(err?.message || t('loginDialog.resetPasswordFailed', '重置失败'));
    } finally {
      setIsLoading(false);
    }
  };

  const switchToForgotPassword = () => {
    resetForm();
    setMode('forgotPassword');
  };

  const switchToLogin = () => {
    resetForm();
    setMode('login');
  };

  if (isCheckingLogin) {
    return null; // 或者显示加载状态
  }

  const isForgotMode = mode === 'forgotPassword';

  return (<>
    <UiModal
      isOpen={isOpen}
      title={
        isForgotMode
          ? t('loginDialog.forgotPasswordTitle', '找回密码')
          : mode === 'login'
            ? t('loginDialog.title', '登录Banana API中台')
            : t('loginDialog.registerTitle', '注册Banana API中台')
      }
      onClose={handleClose}
      widthClassName="w-[440px]"
      footer={
        isForgotMode ? (
          <>
            <UiButton variant="muted" size="sm" onClick={switchToLogin}>
              {t('loginDialog.backToLogin', '返回登录')}
            </UiButton>
            {resetStep === 1 ? (
              <UiButton
                variant="primary"
                size="sm"
                onClick={handleSendResetCode}
                disabled={isLoading || !email.trim() || countdown > 0}
              >
                {isLoading
                  ? t('loginDialog.sendingCode', '发送中...')
                  : countdown > 0
                    ? `${t('loginDialog.resendCode', '重新发送')} (${countdown}s)`
                    : t('loginDialog.sendResetCode', '发送验证码')}
              </UiButton>
            ) : (
              <UiButton
                variant="primary"
                size="sm"
                onClick={handleResetPassword}
                disabled={isLoading || !resetCode.trim() || !password.trim() || password !== confirmPassword}
              >
                {isLoading
                  ? t('loginDialog.resetting', '重置中...')
                  : t('loginDialog.resetPassword', '重置密码')}
              </UiButton>
            )}
          </>
        ) : (
          <>
            <UiButton variant="muted" size="sm" onClick={handleClose}>
              {t('common.cancel', '取消')}
            </UiButton>
            <UiButton
              variant="primary"
              size="sm"
              onClick={handleSubmit}
              disabled={isLoading || !username.trim() || !password.trim() || (mode === 'register' && (!email.trim() || password !== confirmPassword || !agreedToTerms))}
            >
              {isLoading
                ? (mode === 'login'
                    ? t('loginDialog.loggingIn', '登录中...')
                    : t('loginDialog.registering', '注册中...'))
                : (mode === 'login'
                    ? t('loginDialog.login', '登录')
                    : t('loginDialog.register', '注册'))}
            </UiButton>
          </>
        )
      }
    >
      <form onSubmit={(e) => { e.preventDefault(); if (isForgotMode) { resetStep === 1 ? handleSendResetCode() : handleResetPassword(); } else { handleSubmit(e); } }} className="space-y-4">
        {error && (
          <div className="rounded-md bg-red-500/10 border border-red-500/20 px-3 py-2">
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          </div>
        )}

        {/* 模式切换 — 仅在登录/注册模式显示 */}
        {!isForgotMode && (
          <div className="flex border-b border-border">
            <button
              type="button"
              className={`flex-1 py-2 text-sm font-medium ${mode === 'login' ? 'text-primary border-b-2 border-primary' : 'text-text-muted hover:text-text-dark'}`}
              onClick={() => setMode('login')}
              disabled={isLoading}
            >
              {t('loginDialog.login', '登录')}
            </button>
            <button
              type="button"
              className={`flex-1 py-2 text-sm font-medium ${mode === 'register' ? 'text-primary border-b-2 border-primary' : 'text-text-muted hover:text-text-dark'}`}
              onClick={() => setMode('register')}
              disabled={isLoading}
            >
              {t('loginDialog.register', '注册')}
            </button>
          </div>
        )}

        {isForgotMode ? (
          /* 忘记密码表单 */
          <div className="space-y-3">
            {resetStep === 1 ? (
              <div>
                <label className="block text-sm font-medium text-text-dark mb-1.5">
                  {t('loginDialog.email', '邮箱')}
                </label>
                <UiInput
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t('loginDialog.enterEmailForReset', '请输入注册邮箱')}
                  disabled={isLoading}
                  autoFocus
                />
              </div>
            ) : (
              <>
                <div>
                  <label className="block text-sm font-medium text-text-dark mb-1.5">
                    {t('loginDialog.verificationCode', '验证码')}
                  </label>
                  <UiInput
                    type="text"
                    value={resetCode}
                    onChange={(e) => setResetCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder={t('loginDialog.codePlaceholder', '请输入6位验证码')}
                    disabled={isLoading}
                    autoFocus
                    maxLength={6}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-text-dark mb-1.5">
                    {t('loginDialog.newPassword', '新密码')}
                  </label>
                  <UiInput
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t('loginDialog.newPasswordPlaceholder', '请输入新密码')}
                    disabled={isLoading}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-text-dark mb-1.5">
                    {t('loginDialog.confirmPassword', '确认密码')}
                  </label>
                  <UiInput
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder={t('loginDialog.confirmPasswordPlaceholder', '请再次输入密码')}
                    disabled={isLoading}
                  />
                </div>
              </>
            )}
          </div>
        ) : (
          /* 登录/注册表单 */
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-text-dark mb-1.5">
                {t('loginDialog.username', '用户名')}
              </label>
              <UiInput
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={t('loginDialog.usernamePlaceholder', '请输入用户名')}
                disabled={isLoading}
                autoFocus
              />
            </div>

            {mode === 'register' && (
              <div>
                <label className="block text-sm font-medium text-text-dark mb-1.5">
                  {t('loginDialog.email', '邮箱')}
                </label>
                <UiInput
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t('loginDialog.emailPlaceholder', '请输入邮箱')}
                  disabled={isLoading}
                />
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-text-dark mb-1.5">
                {t('loginDialog.password', '密码')}
              </label>
              <UiInput
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t('loginDialog.passwordPlaceholder', '请输入密码')}
                disabled={isLoading}
              />
            </div>

            {mode === 'register' && (
              <>
                <div>
                  <label className="block text-sm font-medium text-text-dark mb-1.5">
                    {t('loginDialog.confirmPassword', '确认密码')}
                  </label>
                  <UiInput
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder={t('loginDialog.confirmPasswordPlaceholder', '请再次输入密码')}
                    disabled={isLoading}
                  />
                </div>
                <div className="flex items-start gap-2">
                  <UiCheckbox
                    checked={agreedToTerms}
                    onCheckedChange={setAgreedToTerms}
                  />
                  <span className="text-xs text-text-muted leading-5 pt-0.5">
                    {t('loginDialog.agreeToTerms', '我已阅读并同意')}
                    <button
                      type="button"
                      className="text-[var(--accent)] hover:underline ml-0.5"
                      onClick={() => setShowNotice(true)}
                    >
                      {t('loginDialog.viewTerms', '《用户须知》')}
                    </button>
                  </span>
                </div>
              </>
            )}
          </div>
        )}

        <div className="text-xs text-text-muted pt-2 border-t border-border space-y-1">
          {isForgotMode ? (
            <p>{t('loginDialog.enterEmailForReset', '请输入注册邮箱')}</p>
          ) : (
            <>
              <p>
                {mode === 'login'
                  ? t('loginDialog.description', '登录后即可使用AI生图功能，系统会根据您的剩余次数进行扣费。')
                  : t('loginDialog.registerDescription', '注册后即可使用AI生图功能，系统会根据您的剩余次数进行扣费。')}
              </p>
              {mode === 'login' && (
                <button
                  type="button"
                  onClick={switchToForgotPassword}
                  className="text-[var(--accent)] hover:underline"
                >
                  {t('loginDialog.forgotPassword', '忘记密码？')}
                </button>
              )}
              {onSwitchToToken && (
                <button
                  type="button"
                  onClick={onSwitchToToken}
                  className="text-[var(--accent)] hover:underline block"
                >
                  {t('loginDialog.switchToToken', '使用令牌激活')}
                </button>
              )}
            </>
          )}
        </div>
      </form>
    </UiModal>

    {showNotice && (
      <UiModal
        isOpen={showNotice}
        title={t('loginDialog.userNoticeTitle', '用户须知')}
        onClose={() => setShowNotice(false)}
        widthClassName="w-[620px]"
        footer={
          <UiButton
            variant="primary"
            size="sm"
            onClick={() => { setAgreedToTerms(true); setShowNotice(false); }}
          >
            {t('common.confirm', '同意并关闭')}
          </UiButton>
        }
      >
        <div className="overflow-y-auto max-h-[55vh] text-sm text-text-dark whitespace-pre-wrap leading-relaxed">
          {USER_NOTICE_CONTENT}
        </div>
      </UiModal>
    )}
  </>);
}