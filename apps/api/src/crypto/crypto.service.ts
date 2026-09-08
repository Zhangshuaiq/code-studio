import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ENVELOPE_VERSION = 'encv1';
const KEY_ID_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/;

@Injectable()
export class CryptoService {
  private readonly activeKeyId: string;
  private readonly keys = new Map<string, Buffer>();

  constructor(config: ConfigService) {
    this.activeKeyId = config.get<string>('CRED_ENCRYPTION_KEY_ID', 'primary');
    if (!KEY_ID_PATTERN.test(this.activeKeyId)) {
      throw new InternalServerErrorException('CRED_ENCRYPTION_KEY_ID 格式非法');
    }
    this.addKey(this.activeKeyId, config.get<string>('CRED_ENCRYPTION_KEY') ?? '');
    for (const item of parsePreviousKeys(config.get<string>('CRED_ENCRYPTION_PREVIOUS_KEYS', ''))) {
      if (this.keys.has(item.id)) {
        throw new InternalServerErrorException(`加密密钥 ID 重复: ${item.id}`);
      }
      this.addKey(item.id, item.hex);
    }
  }

  encrypt(plain: string): string {
    const key = this.keys.get(this.activeKeyId)!;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [
      ENVELOPE_VERSION,
      this.activeKeyId,
      iv.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      encrypted.toString('base64'),
    ].join('.');
  }

  decrypt(blob: string): string {
    const parts = blob.split('.');
    if (parts[0] === ENVELOPE_VERSION) {
      if (parts.length !== 5) throw new InternalServerErrorException('密文信封格式非法');
      const [, keyId, iv, tag, data] = parts;
      const key = this.keys.get(keyId);
      if (!key) throw new InternalServerErrorException(`缺少解密密钥: ${keyId}`);
      return decryptWithKey(key, iv, tag, data);
    }
    if (parts.length !== 3) throw new InternalServerErrorException('密文格式非法');
    for (const key of this.keys.values()) {
      try {
        return decryptWithKey(key, parts[0], parts[1], parts[2]);
      } catch {
        // 旧格式没有 key id，只能逐个尝试已配置密钥。
      }
    }
    throw new InternalServerErrorException('无法使用当前或历史密钥解密旧密文');
  }

  needsRotation(blob: string) {
    const parts = blob.split('.');
    return parts[0] !== ENVELOPE_VERSION || parts[1] !== this.activeKeyId;
  }

  rotate(blob: string) {
    return this.needsRotation(blob) ? this.encrypt(this.decrypt(blob)) : blob;
  }

  activeId() {
    return this.activeKeyId;
  }

  envelopeKeyId(blob: string) {
    const parts = blob.split('.');
    return parts[0] === ENVELOPE_VERSION && parts.length === 5 ? parts[1] : 'legacy';
  }

  private addKey(id: string, hex: string) {
    if (!KEY_ID_PATTERN.test(id) || !/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new InternalServerErrorException(`加密密钥配置非法: ${id}`);
    }
    this.keys.set(id, Buffer.from(hex, 'hex'));
  }
}

export function parsePreviousKeys(value: string) {
  if (!value.trim()) return [];
  return value.split(',').map((entry) => {
    const separator = entry.indexOf(':');
    if (separator <= 0) throw new InternalServerErrorException('CRED_ENCRYPTION_PREVIOUS_KEYS 格式非法');
    return { id: entry.slice(0, separator).trim(), hex: entry.slice(separator + 1).trim() };
  });
}

function decryptWithKey(key: Buffer, ivB64: string, tagB64: string, dataB64: string) {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new InternalServerErrorException('密文认证失败或密钥不匹配');
  }
}
