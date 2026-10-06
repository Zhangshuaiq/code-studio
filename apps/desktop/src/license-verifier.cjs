const crypto = require('node:crypto');

const PAID_EDITIONS = new Set(['personal-pro', 'team', 'enterprise']);

function evaluateLicense(token, options = {}) {
  if (!token) return community('none');
  try {
    if (typeof token !== 'string' || token.length > 32_768) throw new Error('许可证格式无效');
    const parts = token.split('.'); if (parts.length !== 3) throw new Error('许可证格式无效');
    const header = parsePart(parts[0]); const payload = parsePart(parts[1]);
    if (header.alg !== 'EdDSA' || header.typ !== 'JWT') throw new Error('许可证签名算法无效');
    if (!options.publicKey) throw new Error('客户端未配置许可证验证公钥');
    const valid = crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), options.publicKey, Buffer.from(parts[2], 'base64url'));
    if (!valid) throw new Error('许可证签名无效');
    validatePayload(payload, options.deviceId);
    const now = Math.floor((options.now ?? Date.now()) / 1000);
    const state = now <= payload.exp ? 'active' : now <= payload.graceUntil ? 'grace' : 'expired';
    return {
      state, edition: state === 'expired' ? 'community' : payload.edition,
      subject: payload.sub, deviceId: payload.deviceId, expiresAt: iso(payload.exp), graceUntil: iso(payload.graceUntil),
      entitlements: state === 'expired' ? [] : payload.entitlements, challengeNonce: payload.challengeNonce || null, coreCapabilitiesEnabled: true,
    };
  } catch (error) { return { ...community('invalid'), error: error instanceof Error ? error.message : String(error) }; }
}

function validatePayload(payload, expectedDeviceId) {
  if (!payload || typeof payload !== 'object' || typeof payload.sub !== 'string' || !payload.sub || typeof payload.deviceId !== 'string' || !payload.deviceId) throw new Error('许可证声明不完整');
  if (expectedDeviceId && payload.deviceId !== expectedDeviceId) throw new Error('许可证不属于当前设备');
  if (!PAID_EDITIONS.has(payload.edition)) throw new Error('许可证版本无效');
  if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || !Number.isSafeInteger(payload.graceUntil) || payload.exp <= payload.iat || payload.graceUntil < payload.exp) throw new Error('许可证有效期无效');
  if (!Array.isArray(payload.entitlements) || payload.entitlements.length > 100 || payload.entitlements.some((item) => typeof item !== 'string' || !/^[a-z][a-z0-9_.:-]{0,99}$/.test(item))) throw new Error('许可证能力列表无效');
  if (payload.challengeNonce !== undefined && (typeof payload.challengeNonce !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(payload.challengeNonce))) throw new Error('许可证离线申请标识无效');
  payload.entitlements = [...new Set(payload.entitlements)];
}
function parsePart(value) { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); }
function iso(seconds) { return new Date(seconds * 1000).toISOString(); }
function community(state) { return { state, edition: 'community', subject: null, deviceId: null, expiresAt: null, graceUntil: null, entitlements: [], coreCapabilitiesEnabled: true }; }

module.exports = { evaluateLicense };
