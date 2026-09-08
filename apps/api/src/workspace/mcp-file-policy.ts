import { BadRequestException } from '@nestjs/common';

export function isMcpReadablePath(path: string) {
  const segments = path.split('/');
  const filename = segments[segments.length - 1].toLowerCase();
  const hidden = segments.some((segment) => segment.startsWith('.'));
  const sensitive = /^(id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials|secrets?)(\.|$)/i.test(filename)
    || /\.(pem|key|p12|pfx|jks|keystore)$/i.test(filename);
  return !hidden && !sensitive;
}

export function assertMcpReadablePath(path: string) {
  if (!isMcpReadablePath(path)) {
    throw new BadRequestException({
      code: 'MCP_FILE_SENSITIVE',
      message: 'MCP 不允许读取隐藏文件、凭证或私钥文件',
    });
  }
}
