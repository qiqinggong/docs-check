import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {root, readJson, sha256, writeJson, run, requireNode, parseArgs, exists} from './lib.mjs';

let temporary;
try {
  requireNode();
  const {options, positional} = parseArgs(process.argv.slice(2), ['--out-dir', '--tag']);
  if (options.help) {
    console.log('Usage: node scripts/pack.mjs [--out-dir DIRECTORY] [--tag vVERSION]');
    process.exit(0);
  }
  if (positional.length) throw new Error('Unexpected positional argument');
  const pkg = await readJson(path.join(root, 'package.json'));
  const lock = await readJson(path.join(root, 'package-lock.json'));
  if (pkg.name !== 'docs-check' || pkg.version !== lock.version || pkg.name !== lock.name) throw new Error('Package and lock identity differ');
  if (run('git', ['status', '--porcelain'], {cwd: root}).stdout.trim()) throw new Error('Commit source changes before building a package');
  const commit = run('git', ['rev-parse', 'HEAD'], {cwd: root}).stdout.trim();
  const tag = options['--tag'] || null;
  if (tag && (tag !== `v${pkg.version}` || run('git', ['rev-parse', `${tag}^{commit}`], {cwd: root}).stdout.trim() !== commit)) throw new Error('Tag must match the package version and current commit');
  const output = path.resolve(options['--out-dir'] || path.join(root, 'dist'));
  const filename = `${pkg.name}-${pkg.version}.tgz`;
  for (const name of [filename, 'SHA256SUMS', 'build-info.json']) {
    if (await exists(path.join(output, name))) throw new Error(`Output already exists: ${path.join(output, name)}`);
  }
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'docs-check-pack-'));
  const stage = path.join(temporary, 'source');
  await fs.mkdir(stage);
  const copied = ['package.json', 'package-lock.json', 'README.md', 'LICENSE', ...pkg.files.filter(file => !['BUILD.json', 'npm-shrinkwrap.json'].includes(file))];
  for (const file of copied) {
    const target = path.join(stage, file);
    await fs.mkdir(path.dirname(target), {recursive: true});
    await fs.copyFile(path.join(root, file), target);
  }
  const cache = path.resolve(process.env.DOCS_CHECK_NPM_CACHE || path.join(root, '.local/npm-cache'));
  const installed = run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache], {cwd: stage});
  process.stderr.write(installed.stderr);
  run('npm', ['shrinkwrap', '--ignore-scripts', '--offline', '--cache', cache], {cwd: stage});
  const versions = {};
  for (const name of Object.keys(pkg.dependencies)) versions[name] = (await readJson(path.join(stage, 'node_modules', name, 'package.json'))).version;
  const build = {name: pkg.name, version: pkg.version, sourceCommit: commit, tag, sourceLockSha256: await sha256(path.join(root, 'package-lock.json')), buildNode: process.versions.node, buildNpm: run('npm', ['--version']).stdout.trim(), platform: process.platform, arch: process.arch, dependencies: versions};
  await writeJson(path.join(stage, 'BUILD.json'), build);
  const packed = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--cache', cache], {cwd: stage}).stdout)[0];
  const names = new Set(packed.files.map(file => file.path));
  if (!names.has('npm-shrinkwrap.json') || !names.has('BUILD.json') || !names.has('LICENSE') || !packed.bundled.length) throw new Error('Package is missing its lock, provenance, license or bundled dependencies');
  const allowed = new Set(['package.json', 'README.md', 'LICENSE', ...pkg.files]);
  for (const file of names) if (!allowed.has(file) && !file.startsWith('node_modules/')) throw new Error(`Unexpected package content: ${file}`);
  const packagePath = path.join(stage, packed.filename);
  const digest = await sha256(packagePath);
  await fs.mkdir(output, {recursive: true});
  await fs.copyFile(packagePath, path.join(output, filename), fs.constants.COPYFILE_EXCL);
  await fs.writeFile(path.join(output, 'SHA256SUMS'), `${digest}  ${filename}\n`, {flag: 'wx'});
  await writeJson(path.join(output, 'build-info.json'), {...build, filename, sha256: digest, compressedBytes: packed.size, unpackedBytes: packed.unpackedSize, bundledPackageCount: packed.bundled.length});
  console.log(JSON.stringify({package: path.join(output, filename), sha256: digest, sourceCommit: commit, bytes: packed.size, bundledPackages: packed.bundled.length}, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (temporary) await fs.rm(temporary, {recursive: true, force: true});
}
