/**
 * 分销系统 API 前端封装
 * 调用独立分销后端 /jy/distribution/api/
 */

const DIST_API_BASE = 'https://aixiaoxi.top/jy/distribution/api';

export interface DistributorDashboard {
  referral_code: string;
  referral_url: string;
  confirmed_commission: number;
  estimated_commission: number;
  paid: number;
  withdrawable: number;
  team: {
    level1: number;
    level2: number;
    month_new: number;
  };
}

export interface TeamMember {
  username: string;
  user_id: number;
  total_consume: number;
  commission: number;
  level: number;
  invited_by?: number;
  joined_at: string;
}

export interface CommissionRecord {
  id: number;
  from_user: string;
  consume_amount: number;
  commission_amount: number;
  rate: number;
  level: number;
  month: string;
  status: string;
  created_at: string;
}

async function distFetch<T>(
  token: string,
  path: string,
  options?: RequestInit,
): Promise<T> {
  const resp = await fetch(`${DIST_API_BASE}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || '请求失败');
  }
  return resp.json();
}

export async function distributorLogin(
  username: string,
  password: string,
): Promise<{ access_token: string; user_id: number; username: string; referral_code: string }> {
  const resp = await fetch(`${DIST_API_BASE}/distributor/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || '登录失败');
  }
  return resp.json();
}

export async function getDistributorDashboard(token: string): Promise<DistributorDashboard> {
  return distFetch(token, '/distributor/dashboard');
}

export async function getDistributorTeam(token: string): Promise<{ members: TeamMember[] }> {
  return distFetch(token, '/distributor/team');
}

export async function getDistributorCommissions(
  token: string,
  month?: string,
): Promise<{ records: CommissionRecord[]; total: number }> {
  let path = '/distributor/commissions?limit=100';
  if (month) path += '&month=' + month;
  return distFetch(token, path);
}
