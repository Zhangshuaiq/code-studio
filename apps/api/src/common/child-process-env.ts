const SAFE_INHERITED_ENV = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TZ',
  'TMPDIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
] as const;

/** 外部 AI 工具不得继承数据库、JWT、Registry 等整套平台进程环境。 */
export function restrictedChildEnvironment(
  explicit: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_INHERITED_ENV) {
    if (process.env[key]) env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(explicit)) {
    if (value != null && value !== '') env[key] = value;
  }
  return env;
}
