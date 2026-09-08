import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import {
  SaveGitCredentialDto,
  UpdateGitIdentityDto,
} from './dto/git-settings.dto';
import { normalizeGitHost, repositoryHost } from './git-url';

export interface GitIdentity {
  name: string;
  email: string;
}

@Injectable()
export class GitSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async getSettings(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        gitProfile: true,
        gitCredentials: { orderBy: { host: 'asc' } },
      },
    });
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: '用户不存在' });
    const identity = this.identityFromUser(user);
    return {
      identity: {
        authorName: identity.name,
        authorEmail: identity.email,
        configured: !!user.gitProfile,
      },
      credentials: user.gitCredentials.map((item) => ({
        id: item.id,
        host: item.host,
        username: item.username,
        authType: item.authType,
        hasToken: !!item.encryptedToken,
        updatedAt: item.updatedAt,
      })),
    };
  }

  async resolveIdentity(userId: string): Promise<GitIdentity> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { gitProfile: true },
    });
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: '用户不存在' });
    return this.identityFromUser(user);
  }

  async saveIdentity(userId: string, dto: UpdateGitIdentityDto) {
    const authorName = cleanIdentityValue(dto.authorName, 'Git 姓名');
    const authorEmail = cleanIdentityValue(dto.authorEmail, 'Git 邮箱').toLowerCase();
    await this.prisma.userGitProfile.upsert({
      where: { userId },
      create: { userId, authorName, authorEmail },
      update: { authorName, authorEmail },
    });
    return this.getSettings(userId);
  }

  async saveCredential(userId: string, dto: SaveGitCredentialDto) {
    const host = normalizeGitHost(dto.host);
    const existing = await this.prisma.gitCredential.findUnique({
      where: { userId_host: { userId, host } },
    });
    const token = dto.token?.trim();
    if (!token && !existing) {
      throw new BadRequestException({ code: 'GIT_CREDENTIAL_TOKEN_REQUIRED', message: '首次配置该 Git 服务需要提供 Access Token' });
    }
    const encryptedToken = token
      ? this.crypto.encrypt(token)
      : existing!.encryptedToken;
    await this.prisma.gitCredential.upsert({
      where: { userId_host: { userId, host } },
      create: {
        userId,
        host,
        username: dto.username?.trim() || null,
        authType: 'token',
        encryptedToken,
      },
      update: {
        username: dto.username?.trim() || null,
        ...(token ? { encryptedToken } : {}),
      },
    });
    return this.getSettings(userId);
  }

  async removeCredential(userId: string, id: string) {
    const result = await this.prisma.gitCredential.deleteMany({
      where: { id, userId },
    });
    if (!result.count) throw new NotFoundException({ code: 'GIT_CREDENTIAL_NOT_FOUND', message: 'Git 凭据不存在' });
    return { ok: true };
  }

  async credentialForRemote(userId: string, remoteUrl: string) {
    const credential = await this.optionalCredentialForRemote(userId, remoteUrl);
    if (!credential) {
      const host = repositoryHost(remoteUrl);
      throw new BadRequestException({
        code: 'GIT_CREDENTIAL_REQUIRED',
        message: `当前用户尚未配置 ${host} 的推送凭据，请先在账户设置或仓库配置中添加`,
      });
    }
    return credential;
  }

  /** 拉取公开仓库时允许无凭据；私有仓库由 Git 返回鉴权失败。 */
  async optionalCredentialForRemote(userId: string, remoteUrl: string) {
    const host = repositoryHost(remoteUrl);
    const credential = await this.prisma.gitCredential.findUnique({
      where: { userId_host: { userId, host } },
    });
    if (!credential) return null;
    return {
      host,
      username: credential.username ?? undefined,
      token: this.crypto.decrypt(credential.encryptedToken),
    };
  }

  private identityFromUser(user: {
    username: string;
    displayName: string | null;
    email: string | null;
    gitProfile: { authorName: string; authorEmail: string } | null;
  }): GitIdentity {
    // 没显式配置时仍确保每个账户身份不同，不再回退到共享的 CodeGen 用户。
    return {
      name: user.gitProfile?.authorName || user.displayName || user.username,
      email:
        user.gitProfile?.authorEmail ||
        user.email ||
        `${safeLocalPart(user.username)}@users.codegen.local`,
    };
  }
}

function cleanIdentityValue(value: string, label: string): string {
  const cleaned = value.trim();
  if (!cleaned || /[\r\n\0]/.test(cleaned)) {
    throw new BadRequestException({
      code: 'GIT_IDENTITY_INVALID',
      message: `${label}格式不正确`,
    });
  }
  return cleaned;
}

function safeLocalPart(username: string): string {
  return username.toLowerCase().replace(/[^a-z0-9.!#$%&'*+/=?^_`{|}~-]/g, '-') || 'user';
}
