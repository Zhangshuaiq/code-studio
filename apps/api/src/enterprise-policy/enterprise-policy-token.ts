import { createPrivateKey, sign } from 'node:crypto';

export interface EnterprisePolicyClaims {
  organizationId: string; issuedAt: number; expiresAt: number; offlineUntil: number;
  policy: { terminalEnabled: boolean; allowedModelEngines: string[]; allowedConnectorTypes: string[]; allowedGitHosts: string[]; allowedNetworkHosts: string[]; minimumClientVersion: string };
}
export function signEnterprisePolicy(claims: EnterprisePolicyClaims, encodedKey: string, keyId = 'primary') {
  if (!encodedKey) throw new Error('服务端未配置 POLICY_ED25519_PRIVATE_KEY');
  const source = encodedKey.includes('BEGIN') ? encodedKey.replace(/\\n/g, '\n') : Buffer.from(encodedKey, 'base64');
  const privateKey = createPrivateKey(source);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('企业策略签名密钥必须是 Ed25519 私钥');
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: keyId })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')}`;
}
