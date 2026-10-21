import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {root, readJson, sha256, writeJson, run, requireNode, parseArgs, verifyChecksum, exists} from './lib.mjs';
import {spawnSync} from 'node:child_process';

let temporary;
let report;
let reportCreated = false;
try {
  requireNode();
  const {options, positional} = parseArgs(process.argv.slice(2), ['--report-dir']);
  if (options.help) {
    console.log('Usage: node scripts/verify-package.mjs package.tgz [--report-dir DIRECTORY]');
    process.exit(0);
  }
  if (positional.length !== 1) throw new Error('Provide exactly one local package.tgz');
  const packagePath = path.resolve(positional[0]);
  report = path.resolve(options['--report-dir'] || path.join(root, '.local/preflight'));
  if (await exists(report)) throw new Error(`Report directory already exists: ${report}`);
  await fs.mkdir(report, {recursive: true});
  reportCreated = true;
  const digest = await verifyChecksum(packagePath);
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'docs-check-verify-'));
  const prefix = path.join(temporary, 'prefix');
  const cache = path.join(temporary, 'empty-cache');
  const env = {...process.env, DOCS_CHECK_NPM_CACHE: cache};
  const install = run('sh', [path.join(root, 'install.sh'), '--prefix', prefix, packagePath], {cwd: temporary, env});
  await fs.writeFile(path.join(report, 'install.txt'), install.stdout + install.stderr);
  const modulePath = path.join(prefix, 'lib/node_modules/docs-check');
  const entry = path.join(modulePath, 'cli.mjs');
  assert.equal(await fs.realpath(path.join(prefix, 'bin/docs-check')), await fs.realpath(entry));
  assert.notEqual(await fs.realpath(entry), await fs.realpath(path.join(root, 'cli.mjs')));
  const pkg = await readJson(path.join(root, 'package.json'));
  const build = await readJson(path.join(modulePath, 'BUILD.json'));
  assert.equal(build.name, pkg.name);
  assert.equal(build.version, pkg.version);
  assert.equal(build.sourceCommit, run('git', ['rev-parse', 'HEAD'], {cwd: root}).stdout.trim());
  assert.equal(build.sourceLockSha256, await sha256(path.join(root, 'package-lock.json')));
  const topLevel = await fs.readdir(modulePath);
  for (const item of topLevel) assert.ok(['BUILD.json', 'CHANGELOG.md', 'LICENSE', 'README.md', 'cli.mjs', 'docs', 'node_modules', 'npm-shrinkwrap.json', 'package.json'].includes(item), `Unexpected installed file: ${item}`);
  assert.ok(await exists(path.join(modulePath, 'npm-shrinkwrap.json')));
  const version = JSON.parse(run(process.execPath, [entry, '--version', '--json'], {cwd: temporary}).stdout);
  assert.equal(version.version, pkg.version);
  for (const [name, value] of Object.entries(build.dependencies)) assert.equal(version.versions[name], value);
  await writeJson(path.join(report, 'version.json'), version);
  const tests = run(process.execPath, ['--test', path.join(root, 'test/cli.test.mjs')], {cwd: temporary, env: {...env, DOCS_CHECK_TEST_ENTRY: entry}});
  assert.ok(tests.stdout.includes(`CLI under test: ${entry}`), 'Regression did not select the installed CLI');
  await fs.writeFile(path.join(report, 'installed-cli-tests.txt'), tests.stdout + tests.stderr);

  const conflict = path.join(temporary, 'conflict');
  await fs.mkdir(path.join(conflict, 'bin'), {recursive: true});
  await fs.writeFile(path.join(conflict, 'bin/docs-check'), 'unrelated command\n');
  const rejected = spawnSync('sh', [path.join(root, 'install.sh'), '--prefix', conflict, packagePath], {encoding: 'utf8', env});
  assert.notEqual(rejected.status, 0);
  assert.equal(await fs.readFile(path.join(conflict, 'bin/docs-check'), 'utf8'), 'unrelated command\n');
  assert.equal(await exists(path.join(conflict, 'lib')), null);
  await fs.unlink(path.join(conflict, 'bin/docs-check'));
  await fs.symlink(path.join(temporary, 'foreign-command'), path.join(conflict, 'bin/docs-check'));
  const rejectedLink = spawnSync('sh', [path.join(root, 'install.sh'), '--prefix', conflict, packagePath], {encoding: 'utf8', env});
  assert.notEqual(rejectedLink.status, 0);
  assert.equal(await fs.readlink(path.join(conflict, 'bin/docs-check')), path.join(temporary, 'foreign-command'));

  const tampered = path.join(temporary, 'tampered');
  await fs.mkdir(tampered);
  const changed = await fs.readFile(packagePath);
  changed[changed.length - 1] ^= 1;
  const badPackage = path.join(tampered, path.basename(packagePath));
  await fs.writeFile(badPackage, changed);
  await fs.writeFile(path.join(tampered, 'SHA256SUMS'), `${digest}  ${path.basename(packagePath)}\n`);
  const badPrefix = path.join(temporary, 'bad-prefix');
  const bad = spawnSync('sh', [path.join(root, 'install.sh'), '--prefix', badPrefix, badPackage], {encoding: 'utf8', env});
  assert.notEqual(bad.status, 0);
  assert.equal(await exists(badPrefix), null);
  assert.match(bad.stderr, /checksum/);

  const before = await fs.readFile(entry);
  const fakeBin = path.join(temporary, 'fake-bin');
  await fs.mkdir(fakeBin);
  await fs.writeFile(path.join(fakeBin, 'npm'), '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.DOCS_CHECK_FAILURE_TARGET, "damaged during failed update"); process.exit(17);\n', {mode: 0o755});
  const failed = spawnSync('sh', [path.join(root, 'install.sh'), '--prefix', prefix, packagePath], {encoding: 'utf8', env: {...env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`, DOCS_CHECK_FAILURE_TARGET: entry}});
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /state restored/);
  assert.deepEqual(await fs.readFile(entry), before);
  assert.equal(await fs.realpath(path.join(prefix, 'bin/docs-check')), await fs.realpath(entry));
  assert.equal(JSON.parse(run(process.execPath, [entry, '--version', '--json']).stdout).version, pkg.version);
  await writeJson(path.join(report, 'installer-checks.json'), {unknownEntryPreserved: true, unknownLinkPreserved: true, badChecksumRejected: true, failedUpdateRestored: true});
  const testCount = Number(tests.stdout.match(/tests\s+(\d+)/)?.[1]);
  assert.ok(testCount > 0, 'No installed regression tests were reported');
  const summary = {status: 'passed', package: path.basename(packagePath), sha256: digest, sourceCommit: build.sourceCommit, sourceLockSha256: build.sourceLockSha256, node: process.versions.node, npm: run('npm', ['--version']).stdout.trim(), platform: process.platform, arch: process.arch, installedCliTests: testCount, offlineEmptyCacheInstall: true, sourceInstallationIsolated: true, installerChecks: ['unknown entry', 'unknown link', 'checksum mismatch', 'failed update rollback'], remoteMatrixTested: false};
  await writeJson(path.join(report, 'summary.json'), summary);
  console.log(JSON.stringify({...summary, reportDirectory: report}, null, 2));
} catch (error) {
  if (reportCreated) await fs.writeFile(path.join(report, 'failure.txt'), error.stack || error.message).catch(() => {});
  console.error(error.stack || error.message);
  process.exitCode = 1;
} finally {
  if (temporary) await fs.rm(temporary, {recursive: true, force: true});
}
