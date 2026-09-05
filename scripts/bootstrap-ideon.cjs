const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const ideonDir = path.join(root, 'vendor', 'ideon');
const vendorDir = path.dirname(ideonDir);
const corepackCommand = process.platform === 'win32' ? 'corepack.cmd' : 'corepack';

if (!fs.existsSync(vendorDir)) fs.mkdirSync(vendorDir, { recursive: true });

if (!fs.existsSync(path.join(ideonDir, '.git'))) {
  execFileSync('git', ['clone', '--depth', '1', 'https://github.com/3xpyth0n/ideon.git', ideonDir], { stdio: 'inherit' });
}

// pnpm 10/11 blocks dependency lifecycle scripts by default. Ideon needs these
// native modules to compile correctly (SQLite, PTY, SWC, argon2, esbuild, etc.).
const pnpmWorkspace = path.join(ideonDir, 'pnpm-workspace.yaml');
const allowBuildsConfig = `# DexPad bootstrap configuration for upstream Ideon\nallowBuilds:\n  '@swc/core': true\n  argon2: true\n  better-sqlite3: true\n  classic-level: true\n  esbuild: true\n  node-pty: true\n  protobufjs: true\n`;
fs.writeFileSync(pnpmWorkspace, allowBuildsConfig, 'utf8');

execFileSync(corepackCommand, ['pnpm', 'install', '--no-frozen-lockfile'], {
  cwd: ideonDir,
  stdio: 'inherit'
});

// Upstream Ideon currently imports several packages that are not declared as
// direct dependencies. Keep runtime dependencies explicit so the bundled
// server can resolve them under pnpm's strict node_modules layout.
execFileSync(corepackCommand, [
  'pnpm', 'add',
  '@tiptap/core@3.31.3',
  '@tiptap/pm@3.31.3',
  // level@8.0.1 requires classic-level ^1.2.0. 1.4.1 is the newest 1.x release.
  'classic-level@^1.4.1',
  'katex@^0.16.22',
  'lodash@^4.18.1',
  'prismjs@^1.30.0',
  '@types/lodash@^4.17.20'
], {
  cwd: ideonDir,
  stdio: 'inherit'
});

// Kysely's FileMigrationProvider dynamically imports migration files. On
// Windows Node's ESM loader requires absolute filesystem paths to be file://
// URLs. Keep the dynamic import outside webpack so it executes natively at
// runtime instead of being transformed into a webpack context module.
const migrationsFile = path.join(ideonDir, 'src', 'app', 'lib', 'migrations.ts');
if (fs.existsSync(migrationsFile)) {
  let migrationsSource = fs.readFileSync(migrationsFile, 'utf8');

  if (!migrationsSource.includes("import { pathToFileURL } from 'node:url';")) {
    const importNeedle = /import\s+\*\s+as\s+path\s+from\s+['"]node:path['"];\r?\n/;
    if (!importNeedle.test(migrationsSource)) {
      throw new Error('[DexPad] Could not patch Ideon migrations.ts: node:path import not found.');
    }
    migrationsSource = migrationsSource.replace(
      importNeedle,
      (match) => `${match}import { pathToFileURL } from 'node:url';\n`
    );
  }

  const desiredImport = 'import(/* webpackIgnore: true */ pathToFileURL(modulePath).href)';
  const oldImport = 'import(pathToFileURL(modulePath).href)';

  if (!migrationsSource.includes(desiredImport)) {
    if (migrationsSource.includes(oldImport)) {
      migrationsSource = migrationsSource.replaceAll(oldImport, desiredImport);
    } else {
      const migrationFolderLine = /^\s*migrationFolder\s*:\s*.+?,\s*$/m;
      if (!migrationFolderLine.test(migrationsSource)) {
        throw new Error('[DexPad] Could not patch Ideon migrations.ts: migrationFolder line not found.');
      }
      migrationsSource = migrationsSource.replace(
        migrationFolderLine,
        (match) => `${match}\n      import: (modulePath) => ${desiredImport},`
      );
    }
  }

  fs.writeFileSync(migrationsFile, migrationsSource, 'utf8');
  console.log('Ideon Windows migration importer: patched');
}

// Verify from a Node process directly. Using the executable itself avoids
// Windows cmd.exe splitting the JavaScript -e expression at semicolons.
execFileSync(process.execPath, ['-e', "require.resolve('classic-level'); console.log('classic-level: OK')"], {
  cwd: ideonDir,
  stdio: 'inherit'
});

execFileSync(corepackCommand, ['pnpm', 'build'], {
  cwd: ideonDir,
  stdio: 'inherit'
});

console.log('\nIdeon is ready. Start DexPad with: npm run dev');
console.log(`IDEON_ROOT=${ideonDir}`);
