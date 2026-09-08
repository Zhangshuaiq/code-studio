import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CryptoService } from "../crypto/crypto.service";
import * as k8s from "@kubernetes/client-node";
import { posix } from "path";
import { CreateDeployTargetDto, UpdateDeployTargetDto } from "./dto/deploy-target.dto";
import { Prisma } from "@prisma/client";
import { assertSafeKubeconfig } from "../k8s/kubeconfig-policy";

export const TARGET_KINDS = [
  "local-docker",
  "docker-tcp",
  "docker-ssh",
  "k8s",
  "server-artifact",
] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export interface TargetConfig {
  [key: string]: unknown;
  host?: string;
  port?: string | number;
  tls?: boolean;
  username?: string;
  privateKey?: string;
  passphrase?: string;
  hostFingerprint?: string;
  remotePath?: string;
  restartCmd?: string;
  publicHost?: string;
  kubeconfig?: string;
  namespace?: string;
  baseDomain?: string;
  registryId?: string;
  prometheusUrl?: string;
  prometheusBearerToken?: string;
  prometheusUsername?: string;
  prometheusPassword?: string;
  prometheusClusterLabel?: string;
  prometheusClusterValue?: string;
  businessNamespaces?: string[];
}

export interface TargetView {
  id: string;
  name: string;
  kind: string;
  summary: string | null;
  scope: string;
  teamId: string | null;
  team: { id: string; name: string } | null;
  purposes: string[];
  labels: string[];
  enabled: boolean;
  maxPreviewInstances: number;
  capacityCpu: number | null;
  capacityMemoryMb: number | null;
  activePreviewInstances: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface TargetDetailView extends TargetView {
  config: Record<string, unknown>;
}

@Injectable()
export class DeployTargetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async create(
    userId: string,
    input: CreateDeployTargetDto,
  ): Promise<TargetView> {
    const kind = input.kind as TargetKind;
    if (!TARGET_KINDS.includes(kind))
      throw new BadRequestException({ code: "DEPLOY_TARGET_KIND_INVALID", message: "不支持的目标类型" });
    const config = mergeTargetConfig(kind, {}, input.config, false);
    validateConfig(kind, config);
    await this.validateRegistryReference(userId, kind, config);
    const metadata = await this.validateMetadata(userId, kind, input);
    const row = await this.prisma.deployTarget.create({
      data: {
        userId,
        name: input.name.trim(),
        kind,
        encryptedConfig: this.crypto.encrypt(JSON.stringify(config)),
        summary: summarize(kind, config),
        ...metadata,
      },
      include: TARGET_INCLUDE,
    });
    return this.view(row);
  }

  async list(userId: string, purpose?: string): Promise<TargetView[]> {
    const rows = await this.prisma.deployTarget.findMany({
      where: {
        AND: [
          this.visibleWhere(userId),
          ...(purpose ? [{ purposes: { has: purpose } }] : []),
        ],
      },
      include: TARGET_INCLUDE,
      orderBy: { createdAt: "desc" },
    });
    return rows.map((r) => this.view(r));
  }

  async get(userId: string, id: string): Promise<TargetDetailView> {
    const row = await this.prisma.deployTarget.findFirst({
      where: { id, AND: [this.visibleWhere(userId)] },
      include: TARGET_INCLUDE,
    });
    if (!row) throw new NotFoundException({ code: "DEPLOY_TARGET_NOT_FOUND_OR_INACCESSIBLE", message: "部署目标不存在或无权访问" });

    const config = JSON.parse(
      this.crypto.decrypt(row.encryptedConfig),
    ) as TargetConfig;
    return {
      ...this.view(row),
      config: publicConfig(row.kind as TargetKind, config),
    };
  }

  async remove(userId: string, id: string) {
    try {
      await this.prisma.$transaction(async (tx) => {
        const target = await tx.deployTarget.findFirst({
          where: { id, userId },
          include: { _count: { select: { bindings: true, sandboxes: true } } },
        });
        if (!target) throw new NotFoundException({ code: "DEPLOY_TARGET_NOT_FOUND_OR_INACCESSIBLE", message: "部署目标不存在或无权维护" });
        const blockers = { sandboxes: target._count.sandboxes, bindings: target._count.bindings };
        if (blockers.sandboxes > 0 || blockers.bindings > 0) {
          throw new ConflictException({ code: "DEPLOY_TARGET_DELETE_BLOCKED", message: "该运行资源仍有预览实例或项目环境绑定，请先解除关联", blockers });
        }
        await tx.deployTarget.delete({ where: { id } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2003", "P2034"].includes(error.code)) {
        throw new ConflictException({ code: "DEPLOY_TARGET_CONCURRENT_MODIFICATION", message: "部署目标关联关系已发生变化，请刷新后重试" });
      }
      throw error;
    }
    return { ok: true };
  }

  async update(
    userId: string,
    id: string,
    input: UpdateDeployTargetDto,
  ): Promise<TargetView> {
    const current = await this.prisma.deployTarget.findFirst({
      where: { id, userId },
    });
    if (!current) throw new NotFoundException({ code: "DEPLOY_TARGET_NOT_FOUND_OR_INACCESSIBLE", message: "部署目标不存在或无权维护" });
    const currentConfig = JSON.parse(
      this.crypto.decrypt(current.encryptedConfig),
    ) as TargetConfig;
    const kind = current.kind as TargetKind;
    const config = input.config ? mergeTargetConfig(kind, currentConfig, input.config, true) : currentConfig;
    validateConfig(kind, config);
    await this.validateRegistryReference(userId, kind, config);
    const metadata = await this.validateMetadata(userId, kind, {
      ...current,
      ...input,
      teamId: input.teamId === undefined ? current.teamId : input.teamId,
    });
    const row = await this.prisma.deployTarget.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.config
          ? {
              encryptedConfig: this.crypto.encrypt(JSON.stringify(config)),
              summary: summarize(kind, config),
            }
          : {}),
        ...metadata,
      },
      include: TARGET_INCLUDE,
    });
    return this.view(row);
  }

  /** 服务端解析连接配置（部署引擎用，不经 API 暴露） */
  async resolveConfig(
    userId: string,
    id: string,
  ): Promise<{
    id: string;
    kind: string;
    name: string;
    config: Record<string, any>;
    purposes: string[];
    enabled: boolean;
    maxPreviewInstances: number;
    scope: string;
    teamId: string | null;
    ownerId: string;
  }> {
    const t = await this.prisma.deployTarget.findFirst({
      where: { id, AND: [this.visibleWhere(userId)] },
    });
    if (!t) throw new NotFoundException({ code: "DEPLOY_TARGET_NOT_FOUND_OR_INACCESSIBLE", message: "部署目标不存在或无权访问" });
    return {
      id: t.id,
      kind: t.kind,
      name: t.name,
      config: JSON.parse(this.crypto.decrypt(t.encryptedConfig)),
      purposes: t.purposes,
      enabled: t.enabled,
      maxPreviewInstances: t.maxPreviewInstances,
      scope: t.scope,
      teamId: t.teamId,
      ownerId: t.userId,
    };
  }

  private view(row: {
    id: string;
    name: string;
    kind: string;
    summary: string | null;
    scope: string;
    teamId: string | null;
    team: { id: string; name: string } | null;
    purposes: string[];
    labels: string[];
    enabled: boolean;
    maxPreviewInstances: number;
    capacityCpu: number | null;
    capacityMemoryMb: number | null;
    updatedAt: Date;
    _count: { sandboxes: number };
    createdAt: Date;
  }): TargetView {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      summary: row.summary,
      scope: row.scope,
      teamId: row.teamId,
      team: row.team,
      purposes: row.purposes,
      labels: row.labels,
      enabled: row.enabled,
      maxPreviewInstances: row.maxPreviewInstances,
      capacityCpu: row.capacityCpu,
      capacityMemoryMb: row.capacityMemoryMb,
      activePreviewInstances: row._count.sandboxes,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private visibleWhere(userId: string) {
    return {
      OR: [
        { userId },
        { scope: "platform" },
        { scope: "team", team: { members: { some: { id: userId } } } },
      ],
    };
  }

  private async validateMetadata(
    userId: string,
    kind: TargetKind,
    input: {
      scope?: string;
      teamId?: string | null;
      purposes?: string[];
      labels?: string[];
      enabled?: boolean;
      maxPreviewInstances?: number;
      capacityCpu?: number | null;
      capacityMemoryMb?: number | null;
    },
  ) {
    const scope = input.scope ?? "personal";
    if (!["personal", "team", "platform"].includes(scope)) {
      throw new BadRequestException({ code: "DEPLOY_TARGET_SCOPE_INVALID", message: "目标可见范围不正确" });
    }
    const teamId = scope === "team" ? input.teamId || null : null;
    if (scope === "team") {
      if (!teamId) throw new BadRequestException({ code: "DEPLOY_TARGET_TEAM_REQUIRED", message: "项目组目标必须选择项目组" });
      const member = await this.prisma.team.findFirst({
        where: { id: teamId, members: { some: { id: userId } } },
        select: { id: true },
      });
      if (!member) throw new BadRequestException({ code: "DEPLOY_TARGET_TEAM_ACCESS_DENIED", message: "当前用户不属于所选项目组" });
    }
    const purposes = [
      ...new Set(input.purposes?.length ? input.purposes : ["deploy"]),
    ];
    if (purposes.some((item) => !["preview", "deploy"].includes(item))) {
      throw new BadRequestException({ code: "DEPLOY_TARGET_PURPOSE_INVALID", message: "目标用途不正确" });
    }
    if (kind === "server-artifact" && purposes.includes("preview")) {
      throw new BadRequestException({ code: "DEPLOY_TARGET_PURPOSE_UNSUPPORTED", message: "产物直传服务器不能用于开发预览" });
    }
    const maxPreviewInstances = Math.max(
      1,
      Math.min(500, Number(input.maxPreviewInstances) || 10),
    );
    return {
      scope,
      teamId,
      purposes,
      labels: normalizeLabels(input.labels),
      enabled: input.enabled ?? true,
      maxPreviewInstances,
      capacityCpu: positiveOrNull(input.capacityCpu),
      capacityMemoryMb: positiveOrNull(input.capacityMemoryMb, true),
    };
  }

  private async validateRegistryReference(userId: string, kind: TargetKind, config: TargetConfig) {
    if (kind !== "k8s" || !config.registryId) return;
    const registry = await this.prisma.registry.findFirst({
      where: { id: String(config.registryId), userId },
      select: { encryptedConfig: true },
    });
    if (!registry) {
      throw new BadRequestException({ code: "DEPLOY_TARGET_REGISTRY_INVALID", message: "所选镜像仓库不存在或不属于当前用户" });
    }
    const registryConfig = JSON.parse(this.crypto.decrypt(registry.encryptedConfig)) as { insecure?: boolean };
    if (registryConfig.insecure) {
      throw new BadRequestException({ code: "DEPLOY_TARGET_REGISTRY_INSECURE", message: "Kubernetes 目标只能绑定启用 TLS 的镜像仓库" });
    }
  }
}

const TARGET_INCLUDE = {
  team: { select: { id: true, name: true } },
  _count: { select: { sandboxes: true } },
} as const;

const TARGET_CONFIG_FIELDS: Record<TargetKind, readonly string[]> = {
  "local-docker": ["publicHost"],
  "docker-tcp": ["host", "port", "tls", "publicHost"],
  "docker-ssh": ["host", "port", "username", "privateKey", "passphrase", "publicHost"],
  "server-artifact": ["host", "port", "username", "privateKey", "passphrase", "hostFingerprint", "remotePath", "restartCmd", "publicHost"],
  k8s: ["kubeconfig", "namespace", "businessNamespaces", "baseDomain", "registryId", "prometheusUrl", "prometheusBearerToken", "prometheusUsername", "prometheusPassword", "prometheusClusterLabel", "prometheusClusterValue"],
};

const SENSITIVE_CONFIG_FIELDS = new Set(["privateKey", "passphrase", "kubeconfig", "prometheusBearerToken", "prometheusPassword"]);

function mergeTargetConfig(kind: TargetKind, current: TargetConfig, patch: Record<string, unknown>, preserveSecrets: boolean): TargetConfig {
  const result: TargetConfig = {};
  for (const key of TARGET_CONFIG_FIELDS[kind]) {
    if (current[key] !== undefined) result[key] = current[key];
    if (!Object.prototype.hasOwnProperty.call(patch, key) || patch[key] === undefined) continue;
    if (patch[key] === null) { delete result[key]; continue; }
    if (preserveSecrets && SENSITIVE_CONFIG_FIELDS.has(key) && (typeof patch[key] !== "string" || !patch[key].trim())) continue;
    result[key] = patch[key];
  }
  return result;
}

function validateConfig(kind: TargetKind, c: TargetConfig) {
  for (const key of TARGET_CONFIG_FIELDS[kind]) {
    const value = c[key];
    if (value !== undefined && key !== "port" && key !== "tls" && key !== "businessNamespaces" && typeof value !== "string") {
      throw new BadRequestException(`${key} 必须是字符串`);
    }
    if (typeof value === "string" && /[\0\r\n]/.test(value) && !["privateKey", "kubeconfig"].includes(key)) {
      throw new BadRequestException(`${key} 包含非法控制字符`);
    }
  }
  if (typeof c.privateKey === "string" && c.privateKey.length > 65_536) throw new BadRequestException("SSH 私钥内容过大");
  if (typeof c.kubeconfig === "string" && c.kubeconfig.length > 1_048_576) throw new BadRequestException("kubeconfig 内容过大");
  if (typeof c.passphrase === "string" && c.passphrase.length > 2_000) throw new BadRequestException("私钥口令过长");
  if (c.tls !== undefined && typeof c.tls !== "boolean") throw new BadRequestException("tls 必须是布尔值");
  if (c.businessNamespaces !== undefined && (!Array.isArray(c.businessNamespaces) || c.businessNamespaces.length > 100 || c.businessNamespaces.some((value) => typeof value !== "string" || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(value) || value.length > 63))) throw new BadRequestException("businessNamespaces 必须是最多 100 个合法 Kubernetes Namespace");
  for (const key of ["host", "username", "publicHost", "namespace", "baseDomain", "registryId"]) {
    if (typeof c[key] === "string" && c[key].length > 253) throw new BadRequestException(`${key} 内容过长`);
  }
  if (kind === "local-docker") return;
  if (kind === "docker-tcp") {
    if (!c.host || !c.port)
      throw new BadRequestException("需填写 Docker 主机 host 和端口 port");
    const port = Number(c.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new BadRequestException("Docker 端口必须是 1–65535 的整数");
  }
  if (kind === "docker-ssh" || kind === "server-artifact") {
    if (!c.host || !c.username || !c.privateKey)
      throw new BadRequestException("需填写 host / username / 私钥");
    const port = Number(c.port || 22);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new BadRequestException("SSH 端口必须是 1–65535 的整数");
    if (kind === "server-artifact") {
      if (
        c.hostFingerprint &&
        !/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(String(c.hostFingerprint).trim())
      )
        throw new BadRequestException(
          "主机指纹格式应为 SHA256: 开头的 SSH 指纹",
        );
      const remotePath = String(c.remotePath || "").trim();
      if (!remotePath)
        throw new BadRequestException("需填写目标目录 remotePath");
      if (!remotePath.startsWith("/"))
        throw new BadRequestException(
          "目标目录必须是绝对路径，例如 /opt/apps/demo",
        );
      if (posix.normalize(remotePath) === "/")
        throw new BadRequestException("目标目录不能是服务器根目录 /");
      if (/[\0\r\n]/.test(remotePath))
        throw new BadRequestException("目标目录包含非法字符");
      if (c.restartCmd && String(c.restartCmd).length > 2000)
        throw new BadRequestException("重启命令不能超过 2000 个字符");
    }
  }
  if (kind === "k8s") {
    if (!c.kubeconfig) throw new BadRequestException({ code: "DEPLOY_TARGET_KUBECONFIG_REQUIRED", message: "需提供 kubeconfig" });
    assertSafeKubeconfig(String(c.kubeconfig));
    if (c.prometheusUrl) {
      let url: URL;
      try { url = new URL(String(c.prometheusUrl)); }
      catch { throw new BadRequestException("Prometheus 地址格式不正确"); }
      if (!["http:", "https:"].includes(url.protocol))
        throw new BadRequestException("Prometheus 地址仅支持 HTTP/HTTPS");
      if (c.prometheusClusterLabel && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(String(c.prometheusClusterLabel)))
        throw new BadRequestException("Prometheus 集群标签名格式不正确");
      if (c.prometheusClusterValue && !/^[a-zA-Z0-9_.:-]{1,253}$/.test(String(c.prometheusClusterValue)))
        throw new BadRequestException("Prometheus 集群标签值格式不正确");
      if (Boolean(c.prometheusClusterLabel) !== Boolean(c.prometheusClusterValue))
        throw new BadRequestException("Prometheus 集群标签名和值必须同时填写");
    }
  }
}

// 非敏感摘要（列表展示，绝不含私钥/kubeconfig）
function summarize(kind: TargetKind, c: TargetConfig): string {
  if (kind === "local-docker") return "平台 API 节点 Docker";
  if (kind === "docker-tcp") return `docker · ${c.host}:${c.port}`;
  if (kind === "docker-ssh") return `docker · ${c.username}@${c.host}`;
  if (kind === "server-artifact")
    return `server · ${c.username}@${c.host}:${c.remotePath}`;
  if (kind === "k8s") return `k8s · ns=${c.namespace || "default"}`;
  return kind;
}

/** 详情接口只返回连接概况，私钥、口令、kubeconfig 和 token 永不回传。 */
function publicConfig(
  kind: TargetKind,
  c: TargetConfig,
): Record<string, unknown> {
  if (kind === "local-docker") {
    return { publicHost: c.publicHost || null };
  }
  if (kind === "docker-tcp") {
    return {
      host: c.host,
      port: c.port,
      tls: Boolean(c.tls),
      publicHost: c.publicHost || null,
    };
  }
  if (kind === "docker-ssh" || kind === "server-artifact") {
    return {
      host: c.host,
      port: c.port || 22,
      username: c.username,
      privateKeyConfigured: Boolean(c.privateKey),
      passphraseConfigured: Boolean(c.passphrase),
      publicHost: c.publicHost || null,
      hostFingerprintConfigured: Boolean(c.hostFingerprint),
      ...(kind === "server-artifact"
        ? {
            remotePath: c.remotePath,
            restartCmd: c.restartCmd || null,
          }
        : {}),
    };
  }
  if (kind === "k8s") {
    const result: Record<string, unknown> = {
      namespace: c.namespace || "default",
      businessNamespaces: c.businessNamespaces || [],
      baseDomain: c.baseDomain || null,
      registryId: c.registryId || null,
      kubeconfigConfigured: Boolean(c.kubeconfig),
      prometheusUrl: c.prometheusUrl ? safeServerUrl(c.prometheusUrl) : null,
      prometheusAuthConfigured: Boolean(c.prometheusBearerToken || c.prometheusUsername),
      prometheusClusterLabel: c.prometheusClusterLabel || null,
      prometheusClusterValue: c.prometheusClusterValue || null,
    };
    try {
      const kc = new k8s.KubeConfig();
      kc.loadFromString(String(c.kubeconfig || ""));
      const cluster = kc.getCurrentCluster();
      result.kubeconfigValid = true;
      result.currentContext = kc.getCurrentContext() || null;
      result.clusterName = cluster?.name || null;
      result.clusterServer = safeServerUrl(cluster?.server);
    } catch {
      result.kubeconfigValid = false;
    }
    return result;
  }
  return {};
}

function normalizeLabels(values?: string[]): string[] {
  return [
    ...new Set(
      (values ?? [])
        .map((value) => value.trim().toLowerCase())
        .filter((value) => /^[a-z0-9][a-z0-9._=-]{0,63}$/.test(value)),
    ),
  ].slice(0, 30);
}

function positiveOrNull(value?: number | null, integer = false) {
  if (value === null || value === undefined || Number(value) <= 0) return null;
  const parsed = Number(value);
  return integer ? Math.round(parsed) : parsed;
}

function safeServerUrl(server?: string): string | null {
  if (!server) return null;
  try {
    const url = new URL(server);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return server.split("?")[0].split("#")[0];
  }
}
