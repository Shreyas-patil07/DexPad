const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const ideonDir = path.join(root, 'vendor', 'ideon');
const vendorDir = path.dirname(ideonDir);

function runPnpm(args) {
  if (process.platform === 'win32') {
    const corepackJs = path.join(
      path.dirname(process.execPath),
      'node_modules',
      'corepack',
      'dist',
      'corepack.js'
    );
    if (!fs.existsSync(corepackJs)) {
      throw new Error(`[DexPad] Corepack runtime not found: ${corepackJs}`);
    }
    execFileSync(process.execPath, [corepackJs, 'pnpm', ...args], {
      cwd: ideonDir,
      stdio: 'inherit'
    });
    return;
  }

  execFileSync('corepack', ['pnpm', ...args], {
    cwd: ideonDir,
    stdio: 'inherit'
  });
}

if (!fs.existsSync(vendorDir)) fs.mkdirSync(vendorDir, { recursive: true });

if (!fs.existsSync(path.join(ideonDir, '.git'))) {
  execFileSync('git', ['clone', '--depth', '1', 'https://github.com/3xpyth0n/ideon.git', ideonDir], { stdio: 'inherit' });
}

const pnpmWorkspace = path.join(ideonDir, 'pnpm-workspace.yaml');
const allowBuildsConfig = `# DexPad bootstrap configuration for upstream Ideon\nallowBuilds:\n  '@swc/core': true\n  argon2: true\n  better-sqlite3: true\n  classic-level: true\n  esbuild: true\n  node-pty: true\n  protobufjs: true\n`;
fs.writeFileSync(pnpmWorkspace, allowBuildsConfig, 'utf8');

runPnpm(['install', '--no-frozen-lockfile']);

runPnpm([
  'add',
  '@tiptap/core@3.31.3',
  '@tiptap/pm@3.31.3',
  'classic-level@^1.4.1',
  'esbuild@0.28.1',
  'katex@^0.16.22',
  'lodash@^4.18.1',
  'prismjs@^1.30.0',
  '@types/lodash@^4.17.20'
]);

const migrationsSourceDir = path.join(ideonDir, 'src', 'app', 'db', 'migrations');
const runtimeMigrationsDir = path.join(ideonDir, 'runtime-migrations');
const migrationsFile = path.join(ideonDir, 'src', 'app', 'lib', 'migrations.ts');

if (!fs.existsSync(migrationsSourceDir)) {
  throw new Error(`[DexPad] Ideon migrations directory not found: ${migrationsSourceDir}`);
}

const migrationFiles = fs
  .readdirSync(migrationsSourceDir)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
  .sort();

if (!migrationFiles.length) {
  throw new Error('[DexPad] No Ideon migration files were found.');
}

fs.rmSync(runtimeMigrationsDir, { recursive: true, force: true });
fs.mkdirSync(runtimeMigrationsDir, { recursive: true });

// Build each migration as an independent CommonJS module. We deliberately use
// explicit --outfile invocations below because esbuild's multi-entry outdir
// naming can vary with TypeScript entrypoints and produced extensions across
// versions. Explicit output paths make the runtime contract deterministic.
for (const name of migrationFiles) {
  const sourceFile = path.join(migrationsSourceDir, name);
  const outputFile = path.join(runtimeMigrationsDir, `${path.basename(name, '.ts')}.cjs`);
  runPnpm([
    'exec', 'esbuild',
    sourceFile,
    `--outfile=${outputFile}`,
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--target=node20',
    '--sourcemap=external',
    '--log-level=warning',
    `--tsconfig=${path.join(ideonDir, 'tsconfig.json')}`
  ]);

  if (!fs.existsSync(outputFile)) {
    throw new Error(`[DexPad] Migration compilation did not create expected file: ${outputFile}`);
  }
}

let migrationsSource = fs.readFileSync(migrationsFile, 'utf8');
const migrationFolderLine = /^\s*migrationFolder\s*:\s*.+?,\s*$/m;
const migrationFolderReplacement = '      migrationFolder: path.join(process.cwd(), "runtime-migrations"),';

if (!migrationFolderLine.test(migrationsSource)) {
  throw new Error('[DexPad] Could not patch Ideon migrations.ts: migrationFolder line not found.');
}

migrationsSource = migrationsSource.replace(migrationFolderLine, migrationFolderReplacement);

// Kysely's FileMigrationProvider passes Windows filesystem paths to its custom
// importer. Convert those paths to file:// URLs before dynamic import().
const providerImportLine = /\s*import:\s*\([^\n]+=>\s*[^\n]+,?\r?\n?/;
const desiredImportLine = '      import: (modulePath) => import(require("node:url").pathToFileURL(modulePath).href),';

if (providerImportLine.test(migrationsSource)) {
  migrationsSource = migrationsSource.replace(providerImportLine, `\n${desiredImportLine}\n`);
} else {
  migrationsSource = migrationsSource.replace(
    migrationFolderReplacement,
    `${migrationFolderReplacement}\n${desiredImportLine}`
  );
}

fs.writeFileSync(migrationsFile, migrationsSource, 'utf8');
console.log(`Ideon runtime migrations: compiled ${migrationFiles.length} files`);

runPnpm(['exec', 'node', '-e', "require.resolve('classic-level'); require.resolve('esbuild'); console.log('runtime dependencies: OK')"]);

runPnpm(['build']);

console.log('\nIdeon is ready. Start DexPad with: npm run dev');
console.log(`IDEON_ROOT=${ideonDir}`);
