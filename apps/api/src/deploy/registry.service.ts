import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';

export interface RegistryView {
  id: string;
  name: string;
  summary: string | null;
  createdAt: Date;
}

export interface RegistryConfig {
  url: string; // 如 harbor.mycorp.com 或 registry.cn-hangzhou.aliyuncs.com
  project?: string; // 仓库内的 project/namespace，如 codegen
  username: string;
  password: string;
  insecure?: boolean; // http / 自签证书（如本地 registry:2）
}

@Injectable()
export class RegistryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async create(
    userId: string,
    input: { name: string; config: RegistryConfig },
  ): Promise<RegistryView> {
    const cfg = { ...(input.config || ({} as RegistryConfig)) };
    if (!cfg.url?.trim() || !cfg.username?.trim() || !cfg.password)
      throw new BadRequestException({ code: 'REGISTRY_CREDENTIALS_REQUIRED', message: '需填写仓库地址 url / 用户名 / 密码' });
    const rawUrl = cfg.url.trim();
    if (/^http:\/\//i.test(rawUrl) && !cfg.insecure) {
      throw new BadRequestException({ code: 'REGISTRY_TLS_CONFIGURATION_INVALID', message: 'HTTP 镜像仓库必须显式标记 insecure' });
    }
    // 去掉用户误带的协议前缀，统一存主机[:端口][/project]
    cfg.url = rawUrl.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    cfg.username = cfg.username.trim();
    const row = await this.prisma.registry.create({
      data: {
        userId,
        name: input.name.trim(),
        encryptedConfig: this.crypto.encrypt(JSON.stringify(cfg)),
        summary: cfg.project ? `${cfg.url}/${cfg.project}` : cfg.url,
      },
    });
    return this.view(row);
  }

  async list(userId: string): Promise<RegistryView[]> {
    const rows = await this.prisma.registry.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.view(r));
  }

  async remove(userId: string, id: string) {
    try {
      await this.prisma.$transaction(async (tx) => {
        const registry = await tx.registry.findFirst({ where: { id, userId } });
        if (!registry) throw new NotFoundException({ code: 'REGISTRY_NOT_FOUND_OR_INACCESSIBLE', message: '镜像仓库不存在或无权访问' });
        const targets = await tx.deployTarget.findMany({
          where: { userId, kind: 'k8s' },
          select: { id: true, name: true, encryptedConfig: true },
        });
        const bindings = await tx.projectRuntimeBinding.findMany({
          where: { config: { path: ['registryId'], equals: id } },
          select: { id: true },
        });
        const references = targets.filter((target) => {
          try {
            const config = JSON.parse(this.crypto.decrypt(target.encryptedConfig)) as { registryId?: string };
            return config.registryId === id;
          } catch {
            throw new ConflictException({ code: 'REGISTRY_REFERENCE_CHECK_FAILED', message: `部署目标 ${target.name} 的配置无法解析，不能安全删除镜像仓库`, targetId: target.id });
          }
        });
        if (references.length || bindings.length) {
          throw new ConflictException({
            code: 'REGISTRY_DELETE_BLOCKED',
            message: '镜像仓库仍被 Kubernetes 部署目标或项目运行环境引用',
            targets: references.map((target) => ({ id: target.id, name: target.name })),
            bindingCount: bindings.length,
          });
        }
        await tx.registry.delete({ where: { id } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
        throw new ConflictException({ code: 'REGISTRY_CONCURRENT_MODIFICATION', message: '镜像仓库引用关系已发生变化，请刷新后重试' });
      }
      throw error;
    }
    return { ok: true };
  }

  /** 服务端解析仓库凭证（部署推送用，不经 API 暴露） */
  async resolveConfig(userId: string, id: string): Promise<RegistryConfig> {
    const r = await this.prisma.registry.findFirst({ where: { id, userId } });
    if (!r) throw new NotFoundException({ code: 'REGISTRY_NOT_FOUND_OR_INACCESSIBLE', message: '镜像仓库不存在或无权访问' });
    return JSON.parse(this.crypto.decrypt(r.encryptedConfig)) as RegistryConfig;
  }

  private view(row: {
    id: string;
    name: string;
    summary: string | null;
    createdAt: Date;
  }): RegistryView {
    return {
      id: row.id,
      name: row.name,
      summary: row.summary,
      createdAt: row.createdAt,
    };
  }
}
