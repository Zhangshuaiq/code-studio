import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { CreateModelConfigDto } from './dto/create-model-config.dto';
import { UpdateModelConfigDto } from './dto/update-model-config.dto';

// 对外安全视图：绝不含明文/密文 key，只给个尾码用于识别
export interface ModelConfigView {
  id: string;
  label: string;
  provider: string;
  engine: string;
  baseUrl: string;
  model: string;
  keyMasked: string; // 如 "····a1b2"
  isDefault: boolean;
  createdAt: Date;
}

// 生成时用的解密凭证
export interface ResolvedModelCredential {
  provider: string;
  engine: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

@Injectable()
export class ModelConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async create(userId: string, dto: CreateModelConfigDto): Promise<ModelConfigView> {
    const count = await this.prisma.modelConfig.count({ where: { userId } });
    // 第一套强制设为默认；或用户显式要求默认
    const makeDefault = count === 0 || dto.isDefault === true;

    const created = await this.prisma.$transaction(async (tx) => {
      if (makeDefault) {
        await tx.modelConfig.updateMany({
          where: { userId, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.modelConfig.create({
        data: {
          userId,
          label: dto.label,
          provider: dto.provider ?? 'openai-compatible',
          engine: dto.engine ?? 'simple',
          baseUrl: dto.baseUrl.replace(/\/$/, ''),
          model: dto.model,
          encryptedKey: this.crypto.encrypt(dto.apiKey),
          isDefault: makeDefault,
        },
      });
    });
    return this.toView(created);
  }

  async findAll(userId: string): Promise<ModelConfigView[]> {
    const rows = await this.prisma.modelConfig.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map((r) => this.toView(r));
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateModelConfigDto,
  ): Promise<ModelConfigView> {
    await this.ensureOwner(userId, id);
    const data: Record<string, unknown> = {};
    if (dto.label !== undefined) data.label = dto.label;
    if (dto.engine !== undefined) data.engine = dto.engine;
    if (dto.baseUrl !== undefined) data.baseUrl = dto.baseUrl.replace(/\/$/, '');
    if (dto.model !== undefined) data.model = dto.model;
    if (dto.apiKey !== undefined) data.encryptedKey = this.crypto.encrypt(dto.apiKey);

    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.isDefault === true) {
        await tx.modelConfig.updateMany({
          where: { userId, isDefault: true },
          data: { isDefault: false },
        });
        data.isDefault = true;
      }
      return tx.modelConfig.update({ where: { id }, data });
    });
    return this.toView(updated);
  }

  async remove(userId: string, id: string) {
    const cfg = await this.ensureOwner(userId, id);
    await this.prisma.modelConfig.delete({ where: { id } });
    // 删掉的是默认项：把最近一套提升为默认，保证始终有默认可用
    if (cfg.isDefault) {
      const next = await this.prisma.modelConfig.findFirst({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      });
      if (next) {
        await this.prisma.modelConfig.update({
          where: { id: next.id },
          data: { isDefault: true },
        });
      }
    }
    return { ok: true };
  }

  /**
   * 生成时解析该用哪套凭证（纯 BYOK：没配就报错）。
   * 优先用会话指定的 modelConfigId，否则用用户默认。
   */
  async resolveForGeneration(
    userId: string,
    modelConfigId?: string | null,
  ): Promise<ResolvedModelCredential> {
    const cfg = modelConfigId
      ? await this.prisma.modelConfig.findFirst({
          where: { id: modelConfigId, userId },
        })
      : await this.prisma.modelConfig.findFirst({
          where: { userId, isDefault: true },
        });

    if (!cfg) {
      throw new BadRequestException(
        '尚未配置模型：请先在「设置 · 模型」里添加你自己的 API Key（BYOK）',
      );
    }
    return {
      provider: cfg.provider,
      engine: cfg.engine,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      apiKey: this.crypto.decrypt(cfg.encryptedKey),
    };
  }

  private async ensureOwner(userId: string, id: string) {
    const cfg = await this.prisma.modelConfig.findFirst({
      where: { id, userId },
    });
    if (!cfg) throw new NotFoundException('模型配置不存在');
    return cfg;
  }

  private toView(row: {
    id: string;
    label: string;
    provider: string;
    engine: string;
    baseUrl: string;
    model: string;
    encryptedKey: string;
    isDefault: boolean;
    createdAt: Date;
  }): ModelConfigView {
    let last4 = '';
    try {
      const plain = this.crypto.decrypt(row.encryptedKey);
      last4 = plain.slice(-4);
    } catch {
      last4 = '????';
    }
    return {
      id: row.id,
      label: row.label,
      provider: row.provider,
      engine: row.engine,
      baseUrl: row.baseUrl,
      model: row.model,
      keyMasked: `····${last4}`,
      isDefault: row.isDefault,
      createdAt: row.createdAt,
    };
  }
}
