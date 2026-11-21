import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import {
  createDefaultMetadataRegistry,
  lintAnsibleDocument,
  parseAnsibleDocument,
} from '../packages/core/dist/index.js';

const RUNS = 5;

function build300LinePlaybook() {
  const lines = [
    '---',
    '- name: Benchmark 300-line production playbook',
    '  hosts: all',
    '  gather_facts: false',
    '  vars:',
    '    app_env: production',
    '    app_port: 8080',
    '  tasks:',
  ];

  for (let i = 1; i <= 49; i++) {
    lines.push(
      `    - name: Configure service unit ${i}`,
      `      ansible.builtin.copy:`,
      `        content: "PORT={{ app_port }} ENV={{ app_env }} UNIT=${i}\\n"`,
      `        dest: /etc/app/unit-${i}.conf`,
      `        mode: "0644"`,
      `      register: unit_result_${i}`,
    );
  }

  return `${lines.join('\n')}\n`;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ansible-lens-bench-'));
const playbookPath = path.join(tmpDir, 'benchmark-300.yml');
const playbookText = build300LinePlaybook();
fs.writeFileSync(playbookPath, playbookText, 'utf8');
const lineCount = playbookText.trimEnd().split('\n').length;

const registry = createDefaultMetadataRegistry();
const playbookUri = `file://${playbookPath}`;

// Warmup V8 JIT (represents a warm persistent LSP server process)
for (let w = 0; w < 3; w++) {
  const ast = parseAnsibleDocument(playbookUri, playbookText, 'playbook');
  lintAnsibleDocument(ast, registry);
}

const lensTimesMs = [];
let lensDiagCount = 0;
for (let i = 0; i < RUNS; i++) {
  const t0 = performance.now();
  const ast = parseAnsibleDocument(playbookUri, playbookText, 'playbook');
  const diags = lintAnsibleDocument(ast, registry);
  const elapsed = performance.now() - t0;
  lensTimesMs.push(elapsed);
  lensDiagCount = diags.length;
}

let ansibleLintVersion = 'not installed';
const ansibleLintTimesMs = [];
try {
  ansibleLintVersion = execFileSync('ansible-lint', ['--version', '--nocolor'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .trim()
    .split('\n')[0];

  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    try {
      execFileSync('ansible-lint', ['--offline', '--nocolor', '-q', playbookPath], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      // ansible-lint exits with code 2 when lint warnings are found; timing is still valid
      if (err && typeof err === 'object' && 'status' in err && err.status !== 2) {
        throw err;
      }
    }
    ansibleLintTimesMs.push(performance.now() - t0);
  }
} catch (err) {
  console.warn('ansible-lint benchmark skipped:', err instanceof Error ? err.message : String(err));
}

fs.rmSync(tmpDir, { recursive: true, force: true });

const lensMedian = median(lensTimesMs);
const lintMedian = ansibleLintTimesMs.length > 0 ? median(ansibleLintTimesMs) : null;
const speedup = lintMedian !== null ? lintMedian / lensMedian : null;

const cpuModel = os.cpus()[0]?.model ?? 'unknown';
const cpuCores = os.cpus().length;
const totalRamGb = (os.totalmem() / 1024 ** 3).toFixed(1);

const report = [
  '## Ansible Lens vs. ansible-lint Benchmark (300-line Playbook)',
  '',
  `- **Fixture:** ${lineCount} lines (49 tasks)`,
  `- **Runs:** ${RUNS}`,
  `- **Environment:** ${os.platform()} ${os.arch()} (${os.release()}) · ${cpuCores} vCPU (${cpuModel}) · ${totalRamGb} GB RAM`,
  `- **Node.js:** ${process.version}`,
  `- **ansible-lint:** ${ansibleLintVersion}`,
  '',
  '| Tool | Runtime | Median (ms) | Runs (ms) | Diagnostics |',
  '| :--- | :--- | ---: | :--- | ---: |',
  `| **Ansible Lens** (in-process LSP) | Pure TypeScript / Node.js | **${lensMedian.toFixed(2)} ms** | ${lensTimesMs.map((t) => t.toFixed(2)).join(', ')} | ${lensDiagCount} |`,
  lintMedian !== null
    ? `| **ansible-lint** (CLI) | Python | **${lintMedian.toFixed(1)} ms** | ${ansibleLintTimesMs.map((t) => t.toFixed(1)).join(', ')} | — |`
    : '| **ansible-lint** (CLI) | Python | _not installed_ | — | — |',
  '',
  speedup !== null ? `**Speedup:** ~**${Math.round(speedup)}×** faster median analysis time.` : '',
].join('\n');

console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`, 'utf8');
}
