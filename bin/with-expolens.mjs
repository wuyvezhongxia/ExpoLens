#!/usr/bin/env node
/**
 * 在任意 Expo 项目目录执行：用 preload 启动你的命令，不改项目文件。
 * 例：
 *   node /path/to/ExpoLens/bin/with-expolens.mjs npx expo start
 *   npm run with --prefix /path/to/ExpoLens -- npx expo start
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const preload = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'metro-preload.cjs');
const args = process.argv.slice(2);
if (!args.length) {
  console.error('用法: with-expolens <command> [args...]');
  console.error('例:   with-expolens npx expo start');
  process.exit(1);
}

const env = { ...process.env };
const prev = env.NODE_OPTIONS || '';
env.NODE_OPTIONS = prev.includes(preload) ? prev : `${prev} --require ${preload}`.trim();

const child = spawn(args[0], args.slice(1), {
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
