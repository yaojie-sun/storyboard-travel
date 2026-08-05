import { useState, useEffect, useCallback } from 'react';
import { UiButton, UiModal } from '@/components/ui';
import {
  distributorLogin,
  getDistributorDashboard,
  getDistributorTeam,
  getDistributorCommissions,
  type DistributorDashboard as DashboardData,
  type TeamMember,
  type CommissionRecord,
} from '@/commands/referral';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export function DistributionDashboard({ isOpen, onClose }: Props) {
  // Auth
  const [token, setToken] = useState<string>(() => localStorage.getItem('dist_token') || '');
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);

  // Data
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [commissions, setCommissions] = useState<CommissionRecord[]>([]);
  const [activeTab, setActiveTab] = useState<'team' | 'commissions'>('team');
  const [loading, setLoading] = useState(false);

  const loadData = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [dash, teamData] = await Promise.all([
        getDistributorDashboard(token),
        getDistributorTeam(token),
      ]);
      setDashboard(dash);
      setTeam(teamData.members);
    } catch {
      // token may be expired
      localStorage.removeItem('dist_token');
      setToken('');
      setDashboard(null);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (isOpen && token) {
      loadData();
    }
  }, [isOpen, token, loadData]);

  const loadCommissions = async () => {
    if (!token) return;
    try {
      const data = await getDistributorCommissions(token);
      setCommissions(data.records);
    } catch { /* ignore */ }
  };

  const handleLogin = async () => {
    setLoginError('');
    setLoggingIn(true);
    try {
      const result = await distributorLogin(loginUsername, loginPassword);
      localStorage.setItem('dist_token', result.access_token);
      setToken(result.access_token);
      setLoginUsername('');
      setLoginPassword('');
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setLoggingIn(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('dist_token');
    setToken('');
    setDashboard(null);
    setTeam([]);
    setCommissions([]);
  };

  const copyRefLink = () => {
    if (dashboard?.referral_url) {
      navigator.clipboard.writeText(dashboard.referral_url);
    }
  };

  // Login view
  if (!token) {
    return (
      <UiModal isOpen={isOpen} onClose={onClose} title="分销中心">
        <div className="flex flex-col gap-4 p-4">
          <p className="text-sm text-white/50 text-center">
            登录您的分销商账号，查看团队和佣金数据
          </p>
          {loginError && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-sm text-red-400">
              {loginError}
            </div>
          )}
          <input
            className="h-10 rounded-lg bg-white/5 border border-white/10 px-3 text-sm text-white outline-none focus:border-[#f5af19]"
            placeholder="分销商用户名"
            value={loginUsername}
            onChange={e => setLoginUsername(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleLogin()}
          />
          <input
            className="h-10 rounded-lg bg-white/5 border border-white/10 px-3 text-sm text-white outline-none focus:border-[#f5af19]"
            type="password"
            placeholder="密码"
            value={loginPassword}
            onChange={e => setLoginPassword(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleLogin()}
          />
          <UiButton onClick={handleLogin} disabled={loggingIn}>
            {loggingIn ? '登录中...' : '登录'}
          </UiButton>
        </div>
      </UiModal>
    );
  }

  // Dashboard view
  return (
    <UiModal isOpen={isOpen} onClose={onClose} title="分销中心">
      <div className="flex flex-col gap-4 p-4 max-h-[70vh] overflow-y-auto">
        {loading ? (
          <p className="text-sm text-white/30 text-center py-8">加载中...</p>
        ) : dashboard ? (
          <>
            {/* Referral Code */}
            <div className="text-center bg-white/[0.03] rounded-xl p-4">
              <p className="text-xs text-white/40">我的邀请码</p>
              <p className="text-2xl font-bold tracking-widest bg-gradient-to-r from-[#f5af19] to-[#f12711] bg-clip-text text-transparent">
                {dashboard.referral_code}
              </p>
              <p className="text-[10px] text-white/20 break-all mt-1">{dashboard.referral_url}</p>
              <button
                onClick={copyRefLink}
                className="mt-3 text-xs px-4 py-1.5 rounded-lg bg-[#f5af19] text-black font-semibold"
              >
                复制邀请链接
              </button>
            </div>

            {/* Commission Summary */}
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-white/[0.03] rounded-xl p-3 text-center">
                <div className="text-lg font-bold text-[#f5af19]">¥{dashboard.confirmed_commission.toFixed(2)}</div>
                <div className="text-[10px] text-white/40">已确认佣金</div>
              </div>
              <div className="bg-white/[0.03] rounded-xl p-3 text-center">
                <div className="text-lg font-bold text-blue-400">¥{dashboard.estimated_commission.toFixed(2)}</div>
                <div className="text-[10px] text-white/40">预估佣金（下级余额）</div>
              </div>
              <div className="bg-white/[0.03] rounded-xl p-3 text-center">
                <div className="text-lg font-bold text-green-400">¥{dashboard.withdrawable.toFixed(2)}</div>
                <div className="text-[10px] text-white/40">可提现</div>
              </div>
              <div className="bg-white/[0.03] rounded-xl p-3 text-center">
                <div className="text-lg font-bold">¥{dashboard.paid.toFixed(2)}</div>
                <div className="text-[10px] text-white/40">已提现</div>
              </div>
            </div>

            {/* Team */}
            <div className="bg-white/[0.03] rounded-xl p-4">
              <div className="flex gap-6 text-center">
                <div>
                  <div className="text-lg font-bold">{dashboard.team.level1}</div>
                  <div className="text-[10px] text-white/40">一级分销</div>
                </div>
                <div>
                  <div className="text-lg font-bold">{dashboard.team.level2}</div>
                  <div className="text-[10px] text-white/40">二级分销</div>
                </div>
                <div>
                  <div className="text-lg font-bold">{dashboard.team.month_new}</div>
                  <div className="text-[10px] text-white/40">本月新增</div>
                </div>
              </div>
            </div>

            {/* Tabs */}
            <div className="flex gap-2">
              <button
                className={`text-xs px-3 py-1.5 rounded-lg ${activeTab === 'team' ? 'bg-white/10 text-white' : 'text-white/40'}`}
                onClick={() => { setActiveTab('team'); }}
              >
                团队明细
              </button>
              <button
                className={`text-xs px-3 py-1.5 rounded-lg ${activeTab === 'commissions' ? 'bg-white/10 text-white' : 'text-white/40'}`}
                onClick={() => { setActiveTab('commissions'); loadCommissions(); }}
              >
                佣金明细
              </button>
            </div>

            {/* Team Table */}
            {activeTab === 'team' && (
              <div className="bg-white/[0.03] rounded-xl overflow-hidden">
                {team.length === 0 ? (
                  <p className="text-xs text-white/20 text-center py-6">暂无团队成员</p>
                ) : (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-white/5 text-white/40">
                        <th className="text-left py-2 px-3 font-normal">用户</th>
                        <th className="text-right py-2 px-3 font-normal">累计消耗</th>
                        <th className="text-right py-2 px-3 font-normal">佣金</th>
                        <th className="text-center py-2 px-3 font-normal">层级</th>
                      </tr>
                    </thead>
                    <tbody>
                      {team.map((m, i) => (
                        <tr key={i} className="border-b border-white/[0.02]">
                          <td className="py-2 px-3">{m.username}</td>
                          <td className="text-right py-2 px-3">¥{m.total_consume.toFixed(2)}</td>
                          <td className="text-right py-2 px-3">¥{m.commission.toFixed(2)}</td>
                          <td className="text-center py-2 px-3">
                            <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${m.level === 1 ? 'bg-[#f5af19]/15 text-[#f5af19]' : 'bg-blue-400/15 text-blue-400'}`}>
                              {m.level === 1 ? '一级' : '二级'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {/* Commission Table */}
            {activeTab === 'commissions' && (
              <div className="bg-white/[0.03] rounded-xl overflow-hidden">
                {commissions.length === 0 ? (
                  <p className="text-xs text-white/20 text-center py-6">暂无佣金记录</p>
                ) : (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-white/5 text-white/40">
                        <th className="text-left py-2 px-2 font-normal">来源</th>
                        <th className="text-right py-2 px-2 font-normal">消费</th>
                        <th className="text-right py-2 px-2 font-normal">佣金</th>
                        <th className="text-right py-2 px-2 font-normal">比例</th>
                        <th className="text-center py-2 px-2 font-normal">状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {commissions.map((c, i) => (
                        <tr key={i} className="border-b border-white/[0.02]">
                          <td className="py-2 px-2">{c.from_user}</td>
                          <td className="text-right py-2 px-2">¥{c.consume_amount.toFixed(2)}</td>
                          <td className="text-right py-2 px-2">¥{c.commission_amount.toFixed(2)}</td>
                          <td className="text-right py-2 px-2">{(c.rate * 100).toFixed(0)}%</td>
                          <td className="text-center py-2 px-2">
                            <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${c.status === 'confirmed' ? 'bg-green-400/15 text-green-400' : 'bg-white/5 text-white/30'}`}>
                              {c.status === 'confirmed' ? '可提现' : '已打款'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            <p className="text-[10px] text-white/20 text-center">
              佣金由公司财务线下付款，请联系客服或等待财务联系您。
            </p>
          </>
        ) : (
          <p className="text-sm text-white/30 text-center py-8">加载失败，请重试</p>
        )}

        <button
          onClick={handleLogout}
          className="text-xs text-red-400 underline text-center"
        >
          退出分销登录
        </button>
      </div>
    </UiModal>
  );
}
