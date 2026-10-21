#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const jsonOutput = args.includes('--json');
let root = process.cwd();

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function allowedKeys(value, keys, label) {
  if (!object(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`${label}: unsupported option ${key}`);
  }
}

async function hasSymbolicLink(target) {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path is outside project root: ${target}`);
  }
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) return true;
  }
  return false;
}

function emit(result) {
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`docs-check ${result.version || 'unavailable'} | ${result.status}`);
    if (result.root) console.log(`Root: ${result.root}`);
    if (result.files) console.log(`Files: ${result.files.length}`);
    if (result.versions) console.log(Object.entries(result.versions).map(([k, v]) => `${k}=${v}`).join(' '));
    for (const item of result.issues || []) {
      console.log(`${item.file}:${item.line || 1}:${item.column || 1} ${item.rule}: ${item.message}`);
    }
    if (result.error) console.error(result.error);
    if (result.status === 'listed') for (const file of result.files) console.log(file);
  }
}

try {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required');
  let listOnly = false;
  let versionOnly = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('--root requires a directory');
      root = path.resolve(args[++i]);
    } else if (args[i] === '--list-files') {
      listOnly = true;
    } else if (args[i] === '--version') {
      versionOnly = true;
    } else if (args[i] === '--help') {
      console.log('Usage: docs-check [--root DIRECTORY] [--json] [--list-files] [--version]\nChecks project-owned .markdownlint-cli2.jsonc and .remarkrc.json.\nExit: 0 pass/list/version, 1 rule violations, 2 configuration/environment failure.\nRead-only; never installs packages or fixes files.');
      process.exit(0);
    } else if (args[i] !== '--json') {
      throw new Error(`Unknown argument: ${args[i]}`);
    }
  }

  const pkg = JSON.parse(await fs.readFile(new URL('./package.json', import.meta.url), 'utf8'));
  const versions = {node: process.versions.node};
  for (const name of Object.keys(pkg.dependencies)) {
    const installed = JSON.parse(await fs.readFile(new URL(`./node_modules/${name}/package.json`, import.meta.url), 'utf8'));
    versions[name] = installed.version;
  }
  if (versionOnly) {
    emit({status: 'version', version: pkg.version, versions});
    process.exit(0);
  }

  root = await fs.realpath(root);
  const {parse, printParseErrorCode} = await import('jsonc-parser');
  const errors = [];
  const config = parse(await fs.readFile(path.join(root, '.markdownlint-cli2.jsonc'), 'utf8'), errors, {allowTrailingComma: true});
  if (errors.length) throw new Error(`Invalid Markdownlint JSONC: ${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}`);
  allowedKeys(config, ['globs', 'config', 'fix'], 'Markdownlint config');
  if (!Array.isArray(config.globs) || !config.globs.length || config.globs.some(p => typeof p !== 'string' || !p)) {
    throw new Error('globs must contain project-relative file patterns');
  }
  for (const pattern of config.globs) {
    const value = pattern.replace(/^!/, '');
    if (path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) throw new Error('globs must stay within the project root');
  }
  if (!object(config.config)) throw new Error('config must contain Markdownlint rules');
  if ('extends' in config.config) throw new Error('External rule configuration is not supported; declare rules in project config');
  if (config.fix !== undefined && config.fix !== false) throw new Error('Only read-only checks are supported; fix must be false');
  const {default: Ajv} = await import('ajv');
  const schema = JSON.parse(await fs.readFile(new URL('./node_modules/markdownlint/schema/markdownlint-config-schema-strict.json', import.meta.url), 'utf8'));
  const validate = new Ajv({strict: false}).compile(schema);
  if (!validate(config.config)) throw new Error(`Invalid Markdownlint rules: ${JSON.stringify(validate.errors)}`);

  const rc = JSON.parse(await fs.readFile(path.join(root, '.remarkrc.json'), 'utf8'));
  allowedKeys(rc, ['plugins'], 'Remark config');
  if (!Array.isArray(rc.plugins)) throw new Error('Remark plugins must be an array');
  const pluginLoaders = {
    'remark-gfm': () => import('remark-gfm'),
    'remark-validate-links': () => import('remark-validate-links')
  };
  const plugins = [];
  const seen = new Set();
  for (const entry of rc.plugins) {
    const [name, options] = Array.isArray(entry) ? entry : [entry];
    if (!Object.hasOwn(pluginLoaders, name)) throw new Error(`Unsupported or unavailable plugin: ${name}`);
    if (Array.isArray(entry) && entry.length > 2) throw new Error(`Invalid plugin entry: ${name}`);
    if (seen.has(name)) throw new Error(`Duplicate plugin: ${name}`);
    if (options === false) throw new Error(`Required plugin ${name} cannot be disabled`);
    if (name === 'remark-validate-links') {
      allowedKeys(options, ['repository'], 'Link options');
      if (options.repository !== false) throw new Error('Link checks require repository: false');
    }
    seen.add(name);
    plugins.push([(await pluginLoaders[name]()).default, options]);
  }
  if (!seen.has('remark-gfm') || !seen.has('remark-validate-links')) throw new Error('GFM and local link validation plugins are required');

  const {glob} = await import('tinyglobby');
  const files = (await glob(config.globs, {
    cwd: root, onlyFiles: true, followSymbolicLinks: false, expandDirectories: false,
    fs: {
      readdir(directory, options, callback) {
        // A fixed glob prefix can become the crawler root, bypassing its symlink filter.
        hasSymbolicLink(directory)
          .then(skip => skip ? [] : fs.readdir(directory, options))
          .then(entries => callback(null, entries), error => callback(error));
      }
    }
  })).sort();
  if (!files.length) throw new Error('No documentation files matched');
  for (const file of files) {
    if (await hasSymbolicLink(path.join(root, file))) throw new Error(`Symbolic link in scan path: ${file}`);
    const relative = path.relative(root, await fs.realpath(path.join(root, file)));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`File is outside project root: ${file}`);
    if (path.extname(file).toLowerCase() !== '.md') throw new Error(`Only Markdown files are supported: ${file}`);
  }
  const base = {version: pkg.version, root, versions, files};
  if (listOnly) {
    emit({...base, status: 'listed'});
    process.exit(0);
  }

  const {lint} = await import('markdownlint/promise');
  const absoluteFiles = files.map(file => path.join(root, file));
  const lintResults = await lint({files: absoluteFiles, config: config.config});
  const issues = Object.entries(lintResults).flatMap(([file, entries]) => entries.map(item => ({
    file: path.relative(root, file), line: item.lineNumber,
    column: item.errorRange?.[0], rule: item.ruleNames[0], message: item.ruleDescription
  })));
  const {engine} = await import('unified-engine');
  const {remark} = await import('remark');
  const {VFile} = await import('vfile');
  const checked = await new Promise((resolve, reject) => engine({
    processor: remark, cwd: root, files: absoluteFiles.map(file => new VFile({path: file})), plugins, extensions: ['md'],
    detectConfig: false, detectIgnore: false, output: false, out: false, alwaysStringify: false,
    frail: true, reporter: () => ''
  }, (error, code, context) => error ? reject(error) : resolve({code, files: context.files})));
  const actual = checked.files.map(file => path.resolve(root, file.path)).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...absoluteFiles].sort())) throw new Error('Link checker file coverage differs from configured scope');
  for (const file of checked.files) {
    for (const message of file.messages) {
      issues.push({file: path.relative(root, path.resolve(root, file.path)), line: message.line,
        column: message.column, rule: message.ruleId || message.source || 'remark', message: message.reason});
    }
  }
  if (checked.code && !issues.length) throw new Error('Link checker failed without diagnostics');
  const exitCode = issues.length ? 1 : 0;
  emit({...base, status: exitCode ? 'violations' : 'passed', issues, exitCode});
  process.exitCode = exitCode;
} catch (error) {
  emit({status: 'unavailable', root, error: error.message, exitCode: 2});
  process.exitCode = 2;
}
