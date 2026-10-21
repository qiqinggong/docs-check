import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {root, readJson, run, requireNode, parseArgs, verifyChecksum, exists} from './lib.mjs';

let temporary;
let retainBackup = false;
try {
  requireNode();
  const {options, positional} = parseArgs(process.argv.slice(2), ['--prefix']);
  if (options.help) {
    console.log('Usage: ./install.sh [--prefix DIRECTORY] package.tgz\nRequires adjacent SHA256SUMS. Default prefix: ~/.local. Offline install; unknown command entries are rejected.');
    process.exit(0);
  }
  if (positional.length !== 1) throw new Error('Provide exactly one local package.tgz');
  const packagePath = path.resolve(positional[0]);
  const pkg = await readJson(path.join(root, 'package.json'));
  const filename = path.basename(packagePath).match(/^docs-check-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\.tgz$/);
  if (!filename) throw new Error('Expected a docs-check-VERSION.tgz package');
  const expectedVersion = filename[1];
  await verifyChecksum(packagePath);
  const prefix = path.resolve(options['--prefix'] || path.join(os.homedir(), '.local'));
  const modulePath = path.join(prefix, 'lib/node_modules/docs-check');
  const entry = path.join(prefix, 'bin/docs-check');
  const expectedEntry = path.join(modulePath, 'cli.mjs');
  const previousEntry = await exists(entry);
  let oldLink = null;
  if (previousEntry) {
    if (!previousEntry.isSymbolicLink()) throw new Error(`Refusing to replace an unknown command: ${entry}`);
    oldLink = await fs.readlink(entry);
    if (path.resolve(path.dirname(entry), oldLink) !== expectedEntry) throw new Error(`Refusing to replace an unknown command link: ${entry}`);
  }
  const previousModule = await exists(modulePath);
  if (previousModule) {
    if (!previousModule.isDirectory() || previousModule.isSymbolicLink()) throw new Error(`Unknown package directory: ${modulePath}`);
    const installed = await readJson(path.join(modulePath, 'package.json'));
    if (installed.name !== pkg.name || installed.repository?.url !== pkg.repository.url) throw new Error(`Refusing to replace a package from another source: ${modulePath}`);
  }
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'docs-check-install-'));
  const backup = path.join(temporary, 'previous');
  if (previousModule) await fs.cp(modulePath, backup, {recursive: true, verbatimSymlinks: true});
  try {
    const cache = path.resolve(process.env.DOCS_CHECK_NPM_CACHE || path.join(temporary, 'cache'));
    const result = run('npm', ['install', '--global', '--prefix', prefix, '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--cache', cache, packagePath]);
    const installed = await readJson(path.join(modulePath, 'package.json'));
    const build = await readJson(path.join(modulePath, 'BUILD.json'));
    if (installed.name !== pkg.name || installed.repository?.url !== pkg.repository.url || build.name !== pkg.name || installed.version !== expectedVersion || build.version !== expectedVersion || await fs.realpath(entry) !== await fs.realpath(expectedEntry)) throw new Error('Installed package identity or entry does not match');
    const version = JSON.parse(run(process.execPath, [expectedEntry, '--version', '--json']).stdout);
    if (version.status !== 'version' || version.version !== expectedVersion) throw new Error('Installed command failed version validation');
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    console.log(`Installed ${pkg.name} ${expectedVersion}: ${entry}`);
  } catch (error) {
    try {
      const failedEntry = await exists(entry);
      if (failedEntry) {
        if (!failedEntry.isSymbolicLink() || path.resolve(path.dirname(entry), await fs.readlink(entry)) !== expectedEntry) throw new Error(`Unexpected command entry appeared: ${entry}`);
        await fs.unlink(entry);
      }
      await fs.rm(modulePath, {recursive: true, force: true});
      if (previousModule) await fs.cp(backup, modulePath, {recursive: true, verbatimSymlinks: true});
      if (oldLink !== null) {
        await fs.mkdir(path.dirname(entry), {recursive: true});
        await fs.symlink(oldLink, entry);
      }
    } catch (restorationError) {
      retainBackup = true;
      throw new Error(`${error.message}\nRestore failed: ${restorationError.message}\nBackup retained at: ${backup}`);
    }
    throw new Error(`${error.message}\nPrevious package and command state restored.`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (temporary && !retainBackup) await fs.rm(temporary, {recursive: true, force: true});
}
