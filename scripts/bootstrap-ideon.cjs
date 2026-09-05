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

let migrationsSource = fs.readFileSync(migrationsFile, 'utf8');
const migrationFolderLine = /^\s*migrationFolder\s*:\s*.+?,\s*$/m;
const migrationFolderReplacement = '      migrationFolder: path.join(process.cwd(), "runtime-migrations"),';

if (!migrationFolderLine.test(migrationsSource)) {
  throw new Error('[DexPad] Could not patch Ideon migrations.ts: migrationFolder line not found.');
}

migrationsSource = migrationsSource.replace(migrationFolderLine, migrationFolderReplacement);

// FileMigrationProvider gives the custom loader absolute filesystem paths.
// Do not use dynamic import() here: Next/Webpack rewrites it and then tries to
// resolve the runtime-generated .cjs migration files from its own bundle.
// createRequire gives us a real Node CommonJS loader at runtime, while keeping
// the call indirect so Webpack does not turn it into a context module.
const runtimeRequireMarker = 'const __dexpadRuntimeRequire = require("node:module").createRequire(require("node:path").join(process.cwd(), "package.json"));';
const runtimeRequireLine = /^const __dexpadRuntimeRequire = .*;\s*$/m;
if (!runtimeRequireLine.test(migrationsSource)) {
  const importLine = /^import\s+/m.exec(migrationsSource);
  if (importLine) {
    migrationsSource = migrationsSource.slice(0, importLine.index) + `${runtimeRequireMarker}\n` + migrationsSource.slice(importLine.index);
  } else {
    migrationsSource = `${runtimeRequireMarker}\n${migrationsSource}`;
  }
}

const providerImportLine = /\s*import:\s*\([^\n]+=>\s*[^\n]+,?\r?\n?/;
const desiredImportLine = '      import: (modulePath) => Promise.resolve(__dexpadRuntimeRequire(modulePath)),';

if (providerImportLine.test(migrationsSource)) {
  migrationsSource = migrationsSource.replace(providerImportLine, `\n${desiredImportLine}\n`);
} else if (!migrationsSource.includes(desiredImportLine)) {
  migrationsSource = migrationsSource.replace(
    migrationFolderReplacement,
    `${migrationFolderReplacement}\n${desiredImportLine}`
  );
}

fs.writeFileSync(migrationsFile, migrationsSource, 'utf8');

// Build the application first. The upstream build tools clean their own output
// directories; generating runtime-migrations after the build prevents any build
// step from accidentally removing the migration modules we need at runtime.
runPnpm(['build']);

fs.rmSync(runtimeMigrationsDir, { recursive: true, force: true });
fs.mkdirSync(runtimeMigrationsDir, { recursive: true });

// Build each migration as an independent CommonJS module using an explicit
// output file. This guarantees the exact filenames used by FileMigrationProvider.
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

const generatedMigrations = fs
  .readdirSync(runtimeMigrationsDir)
  .filter((name) => name.endsWith('.cjs'))
  .sort();

if (generatedMigrations.length !== migrationFiles.length) {
  throw new Error(
    `[DexPad] Expected ${migrationFiles.length} compiled migrations, found ${generatedMigrations.length}.`
  );
}

console.log(`Ideon runtime migrations: compiled ${generatedMigrations.length} files`);
runPnpm(['exec', 'node', '-e', "require.resolve('classic-level'); require.resolve('esbuild'); console.log('runtime dependencies: OK')"]);
console.log('\nIdeon is ready. Start DexPad with: npm run dev');
console.log(`IDEON_ROOT=${ideonDir}`);
