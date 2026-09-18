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

const AGENT_API_PRESETS = {
  codex: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: '' },
  'claude-code': { provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: '' },
  'deepseek-agent': { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic', model: '' },
  'glm-agent': { provider: 'glm', baseUrl: 'https://open.bigmodel.cn/api/anthropic', model: '' },
} as const;

function agentApiPreset(engine: string) {
  return AGENT_API_PRESETS[engine as keyof typeof AGENT_API_PRESETS];
}

@Injectable()
export class ModelConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async create(userId: string, dto: CreateModelConfigDto): Promise<ModelConfigView> {
    const engine = dto.engine ?? 'simple';
    const agentApi = agentApiPreset(engine);
    if (agentApi && !dto.apiKey?.trim()) {
      throw new BadRequestException('此编码智能体需要用户自己的 API 凭证');
    }
    if (!agentApi && (!dto.baseUrl?.trim() || !dto.model?.trim() || !dto.apiKey?.trim())) {
      throw new BadRequestException('API 模型需要 Base URL、模型名称和 API Key');
    }
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
          provider: agentApi?.provider ?? (dto.provider ?? 'openai-compatible'),
          engine,
          baseUrl: agentApi?.baseUrl ?? dto.baseUrl!.replace(/\/$/, ''),
          model: agentApi ? '' : dto.model!.trim(),
          encryptedKey: this.crypto.encrypt(dto.apiKey!),
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
    const existing = await this.ensureOwner(userId, id);
    const data: Record<string, unknown> = {};
    if (dto.label !== undefined) data.label = dto.label;
    if (dto.engine !== undefined && dto.engine !== existing.engine) {
      throw new BadRequestException('不能修改配置的执行引擎；请新建配置');
    }
    if (dto.baseUrl !== undefined) {
      if (agentApiPreset(existing.engine)) throw new BadRequestException('编码智能体的官方服务地址不可修改');
      data.baseUrl = dto.baseUrl.replace(/\/$/, '');
    }
    if (dto.model !== undefined && !agentApiPreset(existing.engine)) data.model = dto.model;
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
    await this.prisma.$transaction(async (tx) => {
      await tx.session.updateMany({ where: { userId, modelConfigId: id }, data: { modelName: null } });
      await tx.modelConfig.delete({ where: { id } });
    });
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
    modelName?: string | null,
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
        '尚未配置编码助手：请先在「设置 · 模型」添加 Codex、Claude Code 或 API 模型',
      );
    }
    const agentApi = agentApiPreset(cfg.engine);
    if (agentApi) {
      const apiKey = this.crypto.decrypt(cfg.encryptedKey);
      if (!apiKey) throw new BadRequestException('编码智能体尚未配置个人 API 凭证');
      const selectedModel = modelName;
      if (!selectedModel) throw new BadRequestException('请先在对话框选择模型');
      return { provider: agentApi.provider, engine: cfg.engine, baseUrl: agentApi.baseUrl, model: selectedModel, apiKey };
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
      keyMasked: last4 ? `····${last4}` : '未配置 API Key',
      isDefault: row.isDefault,
      createdAt: row.createdAt,
    };
  }

  async assertModelAvailable(userId: string, configId: string, modelName: string): Promise<void> {
    const cfg = await this.ensureOwner(userId, configId);
    if (!agentApiPreset(cfg.engine)) throw new BadRequestException('此配置不支持对话时切换模型');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(modelName)) throw new BadRequestException('模型名称格式无效');
  }

  async availableModels(userId: string, configId: string) {
    const cfg = await this.ensureOwner(userId, configId);
    const endpoint: Record<string, string> = {
      codex: 'https://api.openai.com/v1/models',
      'claude-code': 'https://api.anthropic.com/v1/models?limit=100',
      'deepseek-agent': 'https://api.deepseek.com/models',
      'glm-agent': 'https://open.bigmodel.cn/api/paas/v4/models',
    };
    const url = endpoint[cfg.engine];
    if (!url) return { models: cfg.model ? [{ id: cfg.model, name: cfg.model }] : [], source: 'legacy' };
    const key = this.crypto.decrypt(cfg.encryptedKey);
    if (!key) throw new BadRequestException('请先配置个人 API 凭证');
    const response = await fetch(url, {
      headers: cfg.engine === 'claude-code'
        ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
        : { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    }).catch(() => { throw new BadRequestException('模型列表获取失败，请稍后重试'); });
    if (!response.ok) throw new BadRequestException(response.status === 401 || response.status === 403 ? 'API 凭证无效或无模型列表权限' : `模型列表获取失败（${response.status}）`);
    const payload = await response.json() as { data?: Array<{ id?: string; display_name?: string }> };
    const models = (payload.data ?? [])
      .filter((item): item is { id: string; display_name?: string } => typeof item.id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(item.id))
      .filter((item) => cfg.engine !== 'codex' || /^(gpt-|o\d|codex)/i.test(item.id))
      .map((item) => ({ id: item.id, name: item.display_name || item.id }));
    return { models, source: 'provider-api' };
  }
}
