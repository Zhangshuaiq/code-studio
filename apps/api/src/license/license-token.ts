import { createPrivateKey, sign } from 'node:crypto';

export interface LicenseClaims {
  sub: string; deviceId: string; edition: string; iat: number; exp: number; graceUntil: number; entitlements: string[]; challengeNonce?: string;
}

export function signLicenseToken(claims: LicenseClaims, encodedKey: string, keyId = 'primary') {
  if (!encodedKey) throw new Error('服务端未配置 LICENSE_ED25519_PRIVATE_KEY');
  const source = encodedKey.includes('BEGIN') ? encodedKey.replace(/\\n/g, '\n') : Buffer.from(encodedKey, 'base64');
  const privateKey = createPrivateKey(source);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('许可证签名密钥必须是 Ed25519 私钥');
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: keyId })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
  return `${header}.${payload}.${signature}`;
}
