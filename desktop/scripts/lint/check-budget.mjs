import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const desktopRoot = fileURLToPath(new URL('../..', import.meta.url));
const eslintCli = path.join(desktopRoot, 'node_modules', 'eslint', 'bin', 'eslint.js');
const budgetPath = path.join(desktopRoot, 'scripts', 'lint', 'lint-budget.json');

const result = spawnSync(process.execPath, [eslintCli, '.', '--format', 'json'], {
  cwd: desktopRoot,
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
});

if (!result.stdout) {
  process.stderr.write(result.stderr || 'ESLint did not return JSON output.\n');
  process.exit(result.status || 1);
}

let report;
try {
  report = JSON.parse(result.stdout);
} catch (error) {
  process.stderr.write(`Could not parse ESLint JSON output: ${error.message}\n`);
  process.exit(1);
}

const actual = { errors: 0, warnings: 0, rules: {} };
for (const file of report) {
  actual.errors += file.errorCount || 0;
  actual.warnings += file.warningCount || 0;
  for (const message of file.messages || []) {
    const rule = message.ruleId || (message.message?.startsWith('Unused eslint-disable directive') ? 'eslint/unused-disable' : 'eslint/unassigned');
    actual.rules[rule] = (actual.rules[rule] || 0) + 1;
  }
}

const budget = JSON.parse(await readFile(budgetPath, 'utf8'));
const violations = [];
if (actual.errors > budget.errors) {
  violations.push(`errors ${actual.errors} > budget ${budget.errors}`);
}
if (actual.warnings > budget.warnings) {
  violations.push(`warnings ${actual.warnings} > budget ${budget.warnings}`);
}
for (const [rule, count] of Object.entries(actual.rules)) {
  const allowed = budget.rules[rule] ?? 0;
  if (count > allowed) violations.push(`${rule} ${count} > budget ${allowed}`);
}

console.log(`lint findings: errors=${actual.errors}, warnings=${actual.warnings}`);
if (violations.length) {
  console.error('Lint budget exceeded:\n- ' + violations.join('\n- '));
  process.exit(1);
}
console.log('Lint budget gate passed.');
