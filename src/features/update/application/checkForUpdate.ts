import { getVersion } from '@tauri-apps/api/app';
import { checkForUpgrade } from '../../../commands/update';

export interface CheckResult {
  hasUpdate: boolean;
  latestVersion?: string;
  currentVersion?: string;
  downloadUrl?: string;
  notes?: string;
  error?: 'network' | 'unknown';
}

export async function checkForUpdate(): Promise<CheckResult> {
  try {
    const currentVersion = await getVersion();
    const result = await checkForUpgrade(currentVersion);
    if (!result) {
      return { hasUpdate: false };
    }

    if (result.hasUpdate) {
      return {
        hasUpdate: true,
        latestVersion: result.latestVersion,
        currentVersion: result.currentVersion,
        downloadUrl: result.downloadUrl,
        notes: result.notes,
      };
    }

    return { hasUpdate: false };
  } catch {
    return { hasUpdate: false, error: 'unknown' };
  }
}
