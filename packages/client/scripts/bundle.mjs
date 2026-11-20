import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(clientRoot, '../..');

const sharedOptions = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  minify: false,
  logLevel: 'info',
  banner: {
    js: 'const __ansibleLensImportMetaUrl = require("node:url").pathToFileURL(__filename).href;',
  },
  define: {
    'import.meta.url': '__ansibleLensImportMetaUrl',
  },
  alias: {
    '@ansible-lens/core': path.resolve(repoRoot, 'packages/core/src/index.ts'),
    '@ansible-lens/server': path.resolve(repoRoot, 'packages/server/src/index.ts'),
  },
};

await esbuild.build({
  ...sharedOptions,
  entryPoints: [path.resolve(clientRoot, 'src/extension.ts')],
  outfile: path.resolve(clientRoot, 'dist/extension.cjs'),
  external: ['vscode'],
});

await esbuild.build({
  ...sharedOptions,
  entryPoints: [path.resolve(repoRoot, 'packages/server/src/server.ts')],
  outfile: path.resolve(clientRoot, 'dist/server.cjs'),
});

const coreDataDir = path.resolve(repoRoot, 'packages/core/data');
const distDataDir = path.resolve(clientRoot, 'dist/data');
if (fs.existsSync(coreDataDir)) {
  fs.mkdirSync(distDataDir, { recursive: true });
  for (const entry of fs.readdirSync(coreDataDir)) {
    fs.copyFileSync(path.join(coreDataDir, entry), path.join(distDataDir, entry));
  }
}
