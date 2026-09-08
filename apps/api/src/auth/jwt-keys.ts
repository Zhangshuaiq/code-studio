const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export interface JwtKeyRing {
  activeId: string;
  activeSecret: string;
  keys: Map<string, string>;
}

export function buildJwtKeyRing(values: {
  activeId?: string;
  activeSecret?: string;
  previous?: string;
}): JwtKeyRing {
  const activeId = values.activeId || 'primary';
  const activeSecret = values.activeSecret || 'dev-secret';
  const keys = new Map<string, string>([[activeId, activeSecret]]);
  for (const entry of parsePreviousJwtSecrets(values.previous || '')) {
    if (keys.has(entry.id)) throw new Error(`JWT 密钥 ID 重复: ${entry.id}`);
    keys.set(entry.id, entry.secret);
  }
  return { activeId, activeSecret, keys };
}

export function parsePreviousJwtSecrets(value: string) {
  if (!value.trim()) return [];
  return value.split(',').map((raw) => {
    const separator = raw.indexOf(':');
    const id = separator > 0 ? raw.slice(0, separator).trim() : '';
    const secret = separator > 0 ? raw.slice(separator + 1).trim() : '';
    if (!KEY_ID_PATTERN.test(id) || secret.length < 32) {
      throw new Error('JWT_PREVIOUS_SECRETS 必须是 id:至少32位密钥的逗号分隔列表');
    }
    return { id, secret };
  });
}

export function jwtKeyId(rawToken: string): string | undefined {
  try {
    const encoded = rawToken.split('.')[0];
    const header = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as { kid?: unknown };
    return typeof header.kid === 'string' ? header.kid : undefined;
  } catch {
    return undefined;
  }
}
