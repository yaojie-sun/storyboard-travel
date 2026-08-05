import { invoke, isTauri } from '@tauri-apps/api/core';

export interface UpgradeCheckResult {
  hasUpdate: boolean;
  latestVersion: string;
  currentVersion: string;
  downloadUrl: string;
  notes: string;
}

export async function checkForUpgrade(appVersion: string): Promise<UpgradeCheckResult | null> {
  if (!isTauri()) {
    return null;
  }
  return await invoke<UpgradeCheckResult>('check_for_upgrade', { appVersion });
}
