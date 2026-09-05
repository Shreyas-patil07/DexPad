const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const ideonDir = path.join(root, 'vendor', 'ideon');
const vendorDir = path.dirname(ideonDir);

if (!fs.existsSync(vendorDir)) fs.mkdirSync(vendorDir, { recursive: true });

if (!fs.existsSync(path.join(ideonDir, '.git'))) {
  execFileSync('git', ['clone', '--depth', '1', 'https://github.com/3xpyth0n/ideon.git', ideonDir], { stdio: 'inherit' });
}

// pnpm 10/11 blocks dependency lifecycle scripts by default. Ideon needs these
// native modules to compile correctly (SQLite, PTY, SWC, argon2, esbuild, etc.).
const pnpmWorkspace = path.join(ideonDir, 'pnpm-workspace.yaml');
const allowBuildsConfig = `# DexPad bootstrap configuration for upstream Ideon\nallowBuilds:\n  '@swc/core': true\n  argon2: true\n  better-sqlite3: true\n  classic-level: true\n  esbuild: true\n  node-pty: true\n  protobufjs: true\n`;

fs.writeFileSync(pnpmWorkspace, allowBuildsConfig, 'utf8');

execFileSync('corepack', ['pnpm', 'install', '--no-frozen-lockfile'], {
  cwd: ideonDir,
  stdio: 'inherit',
  shell: process.platform === 'win32'
});

execFileSync('corepack', ['pnpm', 'build'], {
  cwd: ideonDir,
  stdio: 'inherit',
  shell: process.platform === 'win32'
});

console.log('\nIdeon is ready. Start DexPad with: npm run dev');
console.log(`IDEON_ROOT=${ideonDir}`);
