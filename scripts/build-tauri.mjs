import { execSync } from 'child_process';

const isMobile = process.env.TAURI_MOBILE === '1';
const cmd = isMobile ? 'npm run build:mobile' : 'npm run build';

console.log(`[build:tauri] TAURI_MOBILE=${process.env.TAURI_MOBILE || '0'} → ${cmd}`);
execSync(cmd, { stdio: 'inherit' });
