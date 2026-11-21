import path from 'node:path';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

/**
 * Headless VS Code E2E test runner. Downloads a single shared VS Code build and runs
 * the Extension Host suite against both the flat fixture and the nested monorepo fixture.
 */
async function main(): Promise<void> {
  // Inside `__dirname = packages/client/dist/e2e`
  const clientRoot = path.resolve(__dirname, '../..');
  const repoRoot = path.resolve(clientRoot, '../..');
  const extensionTestsPath = path.resolve(__dirname, 'suite.cjs');
  const vscodeExecutablePath = await downloadAndUnzipVSCode('1.95.3');

  const fixtures = [
    path.join(repoRoot, 'test/fixtures/sample-ansible-project'),
    path.join(repoRoot, 'test/fixtures/nested-monorepo-project'),
  ];

  for (const fixturePath of fixtures) {
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: clientRoot,
      extensionTestsPath,
      launchArgs: [
        fixturePath,
        '--disable-extensions',
        '--disable-gpu',
        '--no-sandbox',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-workspace-trust',
      ],
    });
  }
}

void main().catch((error: unknown) => {
  console.error('VS Code E2E suite failed:', error);
  process.exit(1);
});
