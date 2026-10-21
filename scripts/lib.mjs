import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
export const sha256 = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
export const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
export function requireNode() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required');
}
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}):\n${result.stdout || ''}${result.stderr || ''}`);
  return result;
}
export async function exists(file) {
  try { return await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function verifyChecksum(packagePath) {
  const checksumFile = path.join(path.dirname(packagePath), 'SHA256SUMS');
  const rows = (await fs.readFile(checksumFile, 'utf8')).trim().split(/\r?\n/);
  const matches = rows.map(row => row.match(/^([a-f0-9]{64})\s+\*?(.+)$/i))
    .filter(row => row && row[2] === path.basename(packagePath));
  if (matches.length !== 1) throw new Error('SHA256SUMS must contain exactly one entry for this package');
  const actual = await sha256(packagePath);
  if (actual !== matches[0][1].toLowerCase()) throw new Error('Package checksum does not match SHA256SUMS');
  return actual;
}
export function parseArgs(args, names) {
  const options = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (value === '--help' || value === '-h') options.help = true;
    else if (names.includes(value)) {
      if (!args[i + 1] || args[i + 1].startsWith('--') || options[value] !== undefined) throw new Error(`Invalid ${value}`);
      options[value] = args[++i];
    } else if (value.startsWith('-')) throw new Error(`Unknown option: ${value}`);
    else positional.push(value);
  }
  return {options, positional};
}
