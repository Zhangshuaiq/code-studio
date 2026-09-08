import { BadRequestException } from '@nestjs/common';

/** 只允许 HTTPS 仓库地址，并禁止在 URL 中夹带凭据。 */
export function assertRepositoryUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new BadRequestException({ code: 'GIT_REPOSITORY_URL_INVALID', message: '仓库地址格式不正确' });
  }
  if (url.protocol !== 'https:') {
    throw new BadRequestException({ code: 'GIT_REPOSITORY_HTTPS_REQUIRED', message: '仓库地址必须使用 HTTPS' });
  }
  if (!url.hostname || url.username || url.password) {
    throw new BadRequestException({ code: 'GIT_REPOSITORY_CREDENTIALS_FORBIDDEN', message: '仓库地址不能包含用户名或密码' });
  }
  if (url.search || url.hash) {
    throw new BadRequestException({ code: 'GIT_REPOSITORY_URL_INVALID', message: '仓库地址不能包含查询参数或锚点' });
  }
  return url.toString().replace(/\/$/, '');
}

/** 将 github.com、https://github.com/ 等输入统一成小写 host（含可选端口）。 */
export function normalizeGitHost(value: string): string {
  const raw = value.trim();
  if (!raw) throw new BadRequestException({ code: 'GIT_HOST_REQUIRED', message: 'Git 服务地址不能为空' });
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new BadRequestException({ code: 'GIT_HOST_INVALID', message: 'Git 服务地址格式不正确' });
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
    throw new BadRequestException({ code: 'GIT_HOST_INVALID', message: 'Git 服务地址必须是有效的 HTTPS 主机' });
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new BadRequestException({ code: 'GIT_HOST_INVALID', message: 'Git 服务地址只填写主机，例如 github.com' });
  }
  return url.host.toLowerCase();
}

export function repositoryHost(remoteUrl: string): string {
  return new URL(assertRepositoryUrl(remoteUrl)).host.toLowerCase();
}
