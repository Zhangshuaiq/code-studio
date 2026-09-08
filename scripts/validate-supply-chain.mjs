#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifest = JSON.parse(await readFile(resolve(root, 'docs/supply-chain-versions.json'), 'utf8'));
const failures = [];
const digestPattern = /@sha256:[a-f0-9]{64}$/i;
const hashPattern = /^[a-f0-9]{64}$/i;

for (const [name, archive] of Object.entries(manifest.externalArchives ?? {})) {
  if (!archive.version || !archive.url?.includes(String(archive.version))) failures.push(`${name}: URL 未固定到清单版本`);
  if (!hashPattern.test(String(archive.sha256 ?? ''))) failures.push(`${name}: SHA-256 格式非法`);
}

const android = manifest.externalArchives?.androidCommandLineToolsLinux;
const androidDockerfile = await readFile(resolve(root, 'sandbox-images/react-native/Dockerfile'), 'utf8');
if (android) {
  if (!androidDockerfile.includes(`ARG ANDROID_CMDLINE_TOOLS=${android.version}`)) failures.push('React Native Dockerfile 的 Android 工具版本与清单不一致');
  if (!androidDockerfile.includes(`ARG ANDROID_CMDLINE_TOOLS_SHA256=${android.sha256}`)) failures.push('React Native Dockerfile 的 Android 工具哈希与清单不一致');
  if (!androidDockerfile.includes('sha256sum -c -')) failures.push('React Native Dockerfile 未执行 Android 工具哈希校验');
}

if (process.argv.includes('--production')) {
  for (const [runtime, image] of Object.entries(manifest.sandboxBaseImages ?? {})) {
    const value = process.env[image.buildArg];
    if (!value) failures.push(`${runtime}: 生产校验缺少 ${image.buildArg}`);
    else if (!digestPattern.test(value)) failures.push(`${runtime}: ${image.buildArg} 必须固定为 name@sha256:digest`);
  }
}

if (failures.length) {
  console.error(failures.map((item) => `- ${item}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log('供应链静态校验通过');
}
