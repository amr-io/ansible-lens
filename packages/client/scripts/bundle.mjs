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
