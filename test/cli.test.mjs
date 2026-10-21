import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
const cli = process.env.DOCS_CHECK_TEST_ENTRY
  ? path.resolve(process.env.DOCS_CHECK_TEST_ENTRY)
  : fileURLToPath(new URL('../cli.mjs', import.meta.url));
console.log(`CLI under test: ${cli}`);
const format = {globs: ['README.md', 'AGENTS.md', 'docs/**/*.md'], fix: false,
  config: {default: false, MD022: true, MD052: true}};
const links = {plugins: ['remark-gfm', ['remark-validate-links', {repository: false}]]};

async function write(root, file, text) {
  const target = path.join(root, file);
  await fs.mkdir(path.dirname(target), {recursive: true});
  await fs.writeFile(target, text);
}

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'docs-check test-')));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  await write(root, '.markdownlint-cli2.jsonc', JSON.stringify(format));
  await write(root, '.remarkrc.json', JSON.stringify(links));
  await write(root, 'README.md', '# 示例\n\n[说明](docs/guide.md#中文标题)\n');
  await write(root, 'AGENTS.md', '# 协作\n\n正文。\n');
  await write(root, 'docs/guide.md', '# 中文标题\n\n[同页](#中文标题)\n');
  return root;
}

async function digest(root) {
  const entries = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, {withFileTypes: true})) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) entries.push([path.relative(root, target), createHash('sha256').update(await fs.readFile(target)).digest('hex')]);
    }
  }
  await walk(root);
  return entries.sort(([a], [b]) => a.localeCompare(b));
}

async function check(root, expected = 0, extra = [], entry = cli, cwd = os.tmpdir()) {
  const before = await digest(root);
  let result;
  try {
    result = {...await execute(process.execPath, [entry, '--root', root, '--json', ...extra], {cwd}), code: 0};
  } catch (error) {
    result = error;
  }
  assert.equal(result.code, expected, result.stdout + result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(await digest(root), before, 'check changed its inputs');
  return output;
}

test('valid GFM, Chinese anchors and project without npm dependencies', async t => {
  const root = await fixture(t);
  const output = await check(root);
  assert.equal(output.status, 'passed');
  assert.deepEqual(output.files, ['AGENTS.md', 'README.md', 'docs/guide.md']);
  await assert.rejects(fs.stat(path.join(root, 'node_modules')));
});

for (const [name, content, rule] of [
  ['missing file', '# 示例\n\n[缺失](absent.md)\n', 'missing-file'],
  ['missing heading', '# 示例\n\n[缺失](docs/guide.md#不存在)\n', 'missing-heading-in-file'],
  ['table link', '# 示例\n\n| 资料 |\n| --- |\n| [缺失](absent.md) |\n', 'missing-file'],
  ['reference label', '# 示例\n\n[缺失][unknown]\n', 'MD052'],
  ['heading spacing', '# 示例\n正文。\n', 'MD022']
]) {
  test(name, async t => {
    const root = await fixture(t);
    await write(root, 'README.md', content);
    const output = await check(root, 1);
    assert.equal(output.status, 'violations');
    assert.ok(output.issues.some(issue => issue.rule === rule), JSON.stringify(output));
    assert.ok(output.issues.every(issue => !path.isAbsolute(issue.file) && !issue.file.startsWith('../')));
  });
}

test('both checkers report issues from one file set', async t => {
  const root = await fixture(t);
  await write(root, 'README.md', '# 示例\n[缺失](missing.md)\n');
  const output = await check(root, 1);
  assert.ok(output.issues.some(issue => issue.rule === 'MD022'));
  assert.ok(output.issues.some(issue => issue.rule === 'missing-file'));
});

test('single scope, exclusions and expanded docs directory', async t => {
  const root = await fixture(t);
  for (const file of ['shared/broken.md', 'node_modules/broken.md', 'build/broken.md', 'notes.md']) {
    await write(root, file, '# 错误\n[不存在](missing.md)\n');
  }
  await check(root);
  await write(root, 'extra/broken.md', '# 示例\n\n[不存在](missing.md)\n');
  await write(root, '.markdownlint-cli2.jsonc', JSON.stringify({...format, globs: [...format.globs, 'extra/**/*.md']}));
  assert.ok((await check(root, 1)).issues.some(issue => issue.file === 'extra/broken.md'));
  await write(root, '.markdownlint-cli2.jsonc', JSON.stringify({...format, globs: [...format.globs, 'extra/**/*.md', '!extra/broken.md']}));
  await check(root);
});

test('JSONC comments and trailing commas', async t => {
  const root = await fixture(t);
  await write(root, '.markdownlint-cli2.jsonc', '{\n// shared scope\n"globs":["README.md","AGENTS.md","docs/**/*.md"],"config":{"default":false,},"fix":false,\n}\n');
  await check(root);
});

for (const [name, target, value, message] of [
  ['empty scope', '.markdownlint-cli2.jsonc', {...format, globs: ['absent/**/*.md']}, 'No documentation files'],
  ['unknown format option', '.markdownlint-cli2.jsonc', {...format, unrecognized: true}, 'unsupported option'],
  ['invalid rule', '.markdownlint-cli2.jsonc', {...format, config: {default: false, MD999: true}}, 'Invalid Markdownlint rules'],
  ['invalid rule option', '.markdownlint-cli2.jsonc', {...format, config: {MD022: {lines_above: 'invalid'}}}, 'Invalid Markdownlint rules'],
  ['write config', '.markdownlint-cli2.jsonc', {...format, fix: true}, 'read-only'],
  ['scope outside root', '.markdownlint-cli2.jsonc', {...format, globs: ['../**/*.md']}, 'within the project'],
  ['missing plugin', '.remarkrc.json', {plugins: ['remark-absent']}, 'Unsupported or unavailable plugin'],
  ['missing link capability', '.remarkrc.json', {plugins: ['remark-gfm']}, 'plugins are required'],
  ['repository detection', '.remarkrc.json', {plugins: ['remark-gfm', ['remark-validate-links', {}]]}, 'repository: false']
]) {
  test(name, async t => {
    const root = await fixture(t);
    await write(root, target, JSON.stringify(value));
    const output = await check(root, 2);
    assert.equal(output.status, 'unavailable');
    assert.ok(output.error.includes(message), output.error);
  });
}

test('malformed config', async t => {
  const root = await fixture(t);
  await write(root, '.markdownlint-cli2.jsonc', '{invalid');
  assert.match((await check(root, 2)).error, /JSONC/);
});

test('missing config and runtime dependencies', async t => {
  const root = await fixture(t);
  await fs.rm(path.join(root, '.remarkrc.json'));
  assert.equal((await check(root, 2)).status, 'unavailable');
  const installation = await fixture(t);
  await fs.copyFile(cli, path.join(installation, 'cli.mjs'));
  await write(installation, 'package.json', '{"version":"test","dependencies":{"markdownlint":"0.41.1"}}');
  assert.equal((await check(installation, 2, [], path.join(installation, 'cli.mjs'))).status, 'unavailable');
});

test('file listing is not reported as passed checks', async t => {
  const root = await fixture(t);
  await write(root, 'README.md', '# 示例\n正文。\n');
  assert.equal((await check(root, 0, ['--list-files'])).status, 'listed');
});

test('reject fix command and keep input unchanged', async t => {
  const root = await fixture(t);
  assert.match((await check(root, 2, ['--fix'])).error, /Unknown argument/);
});

test('external URLs are not remote availability checks', async t => {
  const root = await fixture(t);
  await write(root, 'README.md', '# 示例\n\n[远端](https://docs-check.invalid/unavailable)\n');
  await check(root);
});

test('concurrent projects, spaces in paths and current-directory default', async t => {
  const a = await fixture(t);
  const b = await fixture(t);
  await write(b, 'README.md', '# 示例\n\n[缺失](absent.md)\n');
  const [left, right] = await Promise.all([check(a), check(b, 1)]);
  assert.equal(left.root, a);
  assert.equal(right.root, b);
  const result = await execute(process.execPath, [cli, '--json'], {cwd: a});
  assert.equal(JSON.parse(result.stdout).root, a);
});
