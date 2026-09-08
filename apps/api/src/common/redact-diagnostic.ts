const PRIVATE_KEY_BLOCK = /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi;
const AUTH_HEADER = /\b(authorization|proxy-authorization)\s*[:=]\s*(?:bearer|basic)\s+[^\s,;]+/gi;
const COOKIE_HEADER = /\b(cookie|set-cookie)\s*:\s*[^\r\n]+/gi;
const SECRET_ASSIGNMENT = /\b(password|passphrase|passwd|pwd|token|api[_-]?key|secret|client[_-]?secret|pgpassword|mysql_pwd)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi;
const QUERY_SECRET = /([?&](?:access_token|token|api_key|apikey|password|secret)=)[^&#\s]+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

export function redactDiagnosticText(value: unknown, explicitSecrets: Array<string | undefined | null> = [], maxLength = 16_000) {
  let text = value instanceof Error ? value.message : String(value ?? '');
  text = text.replace(/\u001b\[[0-9;]*m/g, '');
  text = redactExplicitSecrets(text, explicitSecrets);
  return text
    .replace(PRIVATE_KEY_BLOCK, '***PRIVATE KEY REDACTED***')
    .replace(AUTH_HEADER, '$1: ***')
    .replace(COOKIE_HEADER, '$1: ***')
    .replace(SECRET_ASSIGNMENT, '$1=***')
    .replace(URL_CREDENTIALS, '$1***:***@')
    .replace(QUERY_SECRET, '$1***')
    .replace(JWT, '***JWT REDACTED***')
    .slice(-Math.max(1, maxLength));
}

/** 仅移除调用方明确提供的密钥，不改写普通源码中的 password/token 字样。 */
export function redactExplicitSecrets(value: unknown, explicitSecrets: Array<string | undefined | null> = []) {
  let text = String(value ?? '');
  for (const secret of [...new Set(explicitSecrets.filter((item): item is string => typeof item === 'string' && item.length > 0))].sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join('***').split(encodeURIComponent(secret)).join('***');
  }
  return text;
}

export function diagnosticMessage(error: unknown, explicitSecrets: Array<string | undefined | null> = [], fallback = '未知错误') {
  const message = redactDiagnosticText(error, explicitSecrets);
  return message || fallback;
}
