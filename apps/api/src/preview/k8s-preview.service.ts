import { BadRequestException, ConflictException, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { createHash } from 'node:crypto';
import * as k8s from '@kubernetes/client-node';
import { Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { K8sService } from '../k8s/k8s.service';
import { getRuntime, runtimeDependencyEnv } from '../sandbox/language-runtime';
import { pageArgs, pageResult } from '../common/dto/page-query.dto';
import { AdminPreviewBuildQueryDto, PreviewBuildQueryDto } from './dto/preview-build-query.dto';
import { PreviewSourceSnapshotService } from './preview-source-snapshot.service';
import { PreviewRoutingService } from './preview-routing.service';

interface PreviewBindingConfig {
  image?: string;
  imageRepository?: string;
  dockerfile?: string;
  buildkitImage?: string;
  registryAuthSecret?: string;
  registryId?: string;
  baseDomain: string;
  ingressClassName?: string;
  ingressNamespace?: string;
  ingressPodLabels?: Record<string, string>;
  tlsSecretName?: string;
  imagePullSecret?: string;
  env?: Record<string, string>;
  allowInternet?: boolean;
  buildAllowInternet?: boolean;
  buildEgressCidrs?: string[];
  buildRetries?: number;
  buildTimeoutSeconds?: number;
  startCommand?: string;
  testNamespace?: string;
  testServiceName?: string;
  testServicePort?: number;
  sourceBaseUrl?: string;
  snapshotDownloaderImage?: string;
}

@Injectable()
export class K8sPreviewService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(K8sPreviewService.name);
  private reaper?: NodeJS.Timeout;
  private dispatcher?: NodeJS.Timeout;
  private routeReconciler?: NodeJS.Timeout;
  constructor(private readonly prisma: PrismaService, private readonly k8s: K8sService, private readonly config: ConfigService, private readonly crypto: CryptoService, private readonly snapshots: PreviewSourceSnapshotService, private readonly routing: PreviewRoutingService) {}

  onApplicationBootstrap() {
    if (this.config.get<string>('PROCESS_ROLE', 'api') !== 'worker') return;
    this.reaper = setInterval(() => void this.runSingleton(772001, () => this.reapExpired()), 60_000);
    this.reaper.unref();
    this.dispatcher = setInterval(() => void this.runSingleton(772002, () => this.maintainBuildQueue()), 10_000);
    this.dispatcher.unref();
    this.routeReconciler = setInterval(() => void this.runSingleton(772003, () => this.reconcileRoutes()), 20_000);
    this.routeReconciler.unref();
  }

  onModuleDestroy() { if (this.reaper) clearInterval(this.reaper); if (this.dispatcher) clearInterval(this.dispatcher); if (this.routeReconciler) clearInterval(this.routeReconciler); }

  private async runSingleton(lockId: number, task: () => Promise<unknown>) {
    try {
      await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(${lockId}) AS locked`;
        if (rows[0]?.locked) await task();
      }, { timeout: 30 * 60_000 });
    } catch (error) {
      this.logger.warn(`K8s 预览周期任务失败 lock=${lockId}: ${(error as Error).message}`);
    }
  }

  async startIfBound(userId: string, sessionId: string, requirementId?: string) {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: { project: { include: { remote: true, runtimeBindings: { where: { purpose: 'preview', environment: 'preview', enabled: true }, include: { target: true } } } } },
    });
    const binding = session?.project.runtimeBindings[0];
    if (!binding || binding.target.kind !== 'k8s') return null;
    if (!session.project.teamId) throw new BadRequestException('Kubernetes 预览要求项目属于项目组');
    const config = validatePreviewBindingConfig(binding.config);
    const requirement = requirementId ? await this.prisma.requirement.findFirst({
      where: { id: requirementId, teamId: session.project.teamId, status: { in: ['draft', 'active'] }, team: { members: { some: { id: userId } } } },
      include: { projects: { where: { projectId: session.projectId } } },
    }) : null;
    if (requirementId && !requirement) {
      throw new BadRequestException({ code: 'REQUIREMENT_NOT_FOUND', message: '需求不存在、不可用或与项目组不匹配' });
    }
    const requirementProject = requirement?.projects[0];
    if (requirement && (!requirementProject || !requirementProject.changeRequired)) {
      throw new BadRequestException({ code: 'REQUIREMENT_PROJECT_NOT_DEPLOYABLE', message: '当前项目未关联该需求或被标记为无需变更' });
    }
    if (requirement && requirementProject?.developerId !== userId) {
      throw new BadRequestException({ code: 'REQUIREMENT_PREVIEW_ACCESS_DENIED', message: '只有该关联项目被指派的开发负责人可以部署需求预览' });
    }
    if (requirement && (!requirementProject?.branchName || requirementProject.sessionId !== sessionId || session.workspaceBranch !== requirementProject.branchName)) {
      throw new BadRequestException({ code: 'REQUIREMENT_BRANCH_REQUIRED', message: '请先在当前用户工作区创建并切换到该项目的需求分支' });
    }
    const serviceKey = requirementProject?.serviceKey;
    if (requirement) {
      const conflict = await this.prisma.previewInstance.findFirst({
        where: { requirementId: requirement.id, serviceKey, sessionId: { not: sessionId }, status: { in: ['starting', 'ready'] } },
        select: { id: true },
      });
      if (conflict) throw new ConflictException({ code: 'PREVIEW_SERVICE_KEY_CONFLICT', message: `该需求中服务 ${serviceKey} 已由其他项目部署` });
    }
    const runtime = getRuntime(session.project.language);
    if (!runtime.preview.port || runtime.preview.kind === 'emulator' || runtime.preview.kind === 'none') {
      throw new BadRequestException(`${runtime.displayName} 暂不支持 Kubernetes Web 预览`);
    }
    const baseline = await this.k8s.provisionPreviewNamespace(binding.targetId, userId, session.project.teamId);
    const { coreApi, appsApi, networkingApi, batchApi, config: targetConfig } = await this.k8s.getAuthorizedClients(binding.targetId, userId);
    if (requirement && (!config.testNamespace || !targetConfig.businessNamespaces?.includes(config.testNamespace))) {
      throw new BadRequestException({ code: 'PREVIEW_TEST_NAMESPACE_DENIED', message: '联调预览必须配置运行目标已授权的测试 Namespace' });
    }
    const testAccess = requirement
      ? await this.resolveTestService(coreApi, config.testNamespace!, config.testServiceName || serviceKey!, config.testServicePort || 80)
      : undefined;
    const name = resourceName(sessionId);
    const namespace = baseline.namespace;
    const labels = {
      'app.kubernetes.io/name': 'codegen-preview',
      'app.kubernetes.io/instance': name,
      'codegen.io/project-id': session.projectId,
      'codegen.io/session-id': sessionId,
      'codegen.io/owner-id': userId,
      'codegen.io/environment': 'preview',
      ...(requirement ? {
        'codegen.io/requirement-no': requirement.requirementNo.toLowerCase(),
        'codegen.io/service-key': serviceKey!,
      } : {}),
      'app.kubernetes.io/component': 'preview-runtime',
    };
    const image = config.image || `${config.imageRepository}:preview-${sessionId.replace(/-/g, '').slice(0, 12)}-${Date.now().toString(36)}`;
    const buildJob = config.image ? undefined : `${name}-b-${Date.now().toString(36)}`;
    const sourceSnapshot = buildJob ? await this.snapshots.create(userId, sessionId, session.projectId) : undefined;
    const sourceBaseUrl = config.sourceBaseUrl || this.config.get<string>('PREVIEW_SOURCE_BASE_URL');
    if (sourceSnapshot && (!sourceBaseUrl || !/^https:\/\/[A-Za-z0-9._~:/-]+$/.test(sourceBaseUrl))) {
      await this.snapshots.remove(sourceSnapshot.id);
      throw new BadRequestException({ code: 'PREVIEW_SOURCE_BASE_URL_REQUIRED', message: '工作区快照构建缺少目标集群可访问的 HTTPS PREVIEW_SOURCE_BASE_URL' });
    }
    const snapshotSource = sourceSnapshot ? { ...sourceSnapshot, url: `${sourceBaseUrl!.replace(/\/$/, '')}/api/preview-sources/${sourceSnapshot.id}` } : undefined;
    let managedSecrets: { registrySecret?: string; sourceSecret?: string };
    try {
      managedSecrets = await this.ensureBuildSecrets(coreApi, namespace, name, binding.target.userId, config, image, snapshotSource);
    } catch (error) {
      await this.snapshots.remove(sourceSnapshot?.id);
      throw error;
    }
    let buildRecordId: string | undefined;
    if (buildJob) {
      const buildRecord = await this.reserveBuild({ sessionId, projectId: session.projectId, userId, teamId: session.project.teamId, targetId: binding.targetId, namespace, jobName: buildJob, image }).catch(async (error) => {
        await Promise.allSettled([
          ...(managedSecrets.sourceSecret ? [coreApi.deleteNamespacedSecret({ name: managedSecrets.sourceSecret, namespace })] : []),
          ...(managedSecrets.registrySecret ? [coreApi.deleteNamespacedSecret({ name: managedSecrets.registrySecret, namespace })] : []),
        ]);
        await this.snapshots.remove(sourceSnapshot?.id);
        throw error;
      });
      buildRecordId = buildRecord.id;
      const job = buildkitJob(buildJob, namespace, labels, config, image, managedSecrets.registrySecret, managedSecrets.sourceSecret, buildRecord.status === 'queued');
      try {
        await batchApi.createNamespacedJob({ namespace, body: job });
      } catch (error) {
        await this.finishBuild(buildRecordId, 'failed', `无法创建 BuildKit Job: ${(error as Error).message}`);
        await Promise.allSettled([
          ...(managedSecrets.sourceSecret ? [coreApi.deleteNamespacedSecret({ name: managedSecrets.sourceSecret, namespace })] : []),
          ...(managedSecrets.registrySecret ? [coreApi.deleteNamespacedSecret({ name: managedSecrets.registrySecret, namespace })] : []),
        ]);
        await this.snapshots.remove(sourceSnapshot?.id);
        throw error;
      }
    }
    const port = runtime.preview.port;
    const command = config.startCommand || [...(runtime.installCommand ? [runtime.installCommand] : []), runtime.preview.startCommand].filter(Boolean).join(' && ');
    const deployment: k8s.V1Deployment = {
      metadata: { name, namespace, labels },
      spec: {
        replicas: 1, revisionHistoryLimit: 2, progressDeadlineSeconds: 1200,
        selector: { matchLabels: { 'app.kubernetes.io/instance': name } },
        template: {
          metadata: { labels },
          spec: {
            serviceAccountName: baseline.serviceAccount,
            automountServiceAccountToken: false,
            imagePullSecrets: (managedSecrets.registrySecret || config.imagePullSecret) ? [{ name: managedSecrets.registrySecret || config.imagePullSecret! }] : undefined,
            securityContext: { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } },
            containers: [{
              name: 'preview', image, imagePullPolicy: buildJob ? 'Always' : 'IfNotPresent',
              command: ['sh', '-c', command],
              ports: [{ name: 'http', containerPort: port, protocol: 'TCP' }],
              env: Object.entries({
                ...runtimeDependencyEnv(
                  runtime,
                  this.config.get<string>('DEPENDENCY_NPM_REGISTRY'),
                  this.config.get<string>('DEPENDENCY_PIP_INDEX_URL'),
                  this.config.get<string>('DEPENDENCY_MAVEN_MIRROR_URL'),
                  this.config.get<string>('DEPENDENCY_ACCESS_POLICY'),
                  this.config.get<string>('K8S_GENERATION_REQUIRE_DEPENDENCY_PROXY'),
                ),
                ...config.env,
                // 平台管理属性必须覆盖用户配置，避免伪造 Trace 的项目归属。
                OTEL_EXPORTER_OTLP_ENDPOINT: this.config.get<string>('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://otel-collector.observability:4318'),
                OTEL_RESOURCE_ATTRIBUTES: `codegen.project.id=${session.projectId},deployment.environment.name=preview`,
                OTEL_SERVICE_NAME: serviceKey || name,
                ...(requirement ? {
                  CODEGEN_REQUIREMENT_NO: requirement.requirementNo,
                  CODEGEN_SERVICE_KEY: serviceKey!,
                  CODEGEN_FALLBACK_ENVIRONMENT: 'test',
                } : {}),
              }).map(([name, value]) => ({ name, value })),
              resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '1', memory: '1Gi' } },
              securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, runAsNonRoot: true },
              readinessProbe: { httpGet: { path: '/', port: 'http' }, initialDelaySeconds: 3, periodSeconds: 5, failureThreshold: 12 },
            }],
          },
        },
      },
    };
    const service: k8s.V1Service = { metadata: { name, namespace, labels }, spec: { selector: { 'app.kubernetes.io/instance': name }, ports: [{ name: 'http', port, targetPort: 'http' }], type: 'ClusterIP' } };
    const host = `${requirement ? routeHostLabel(serviceKey!, requirement.requirementNo.toLowerCase()) : name}.${config.baseDomain}`;
    const ingress: k8s.V1Ingress = {
      metadata: { name, namespace, labels },
      spec: {
        ingressClassName: config.ingressClassName || 'nginx',
        rules: [{ host, http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name, port: { name: 'http' } } } }] } }],
        tls: config.tlsSecretName ? [{ hosts: [host], secretName: config.tlsSecretName }] : undefined,
      },
    };
    await upsert(() => appsApi.readNamespacedDeployment({ name, namespace }), () => appsApi.createNamespacedDeployment({ namespace, body: deployment }), (rv) => appsApi.replaceNamespacedDeployment({ name, namespace, body: withVersion(deployment, rv) }));
    await upsert(() => coreApi.readNamespacedService({ name, namespace }), () => coreApi.createNamespacedService({ namespace, body: service }), (rv) => coreApi.replaceNamespacedService({ name, namespace, body: withVersion(service, rv) }));
    await upsert(() => networkingApi.readNamespacedIngress({ name, namespace }), () => networkingApi.createNamespacedIngress({ namespace, body: ingress }), (rv) => networkingApi.replaceNamespacedIngress({ name, namespace, body: withVersion(ingress, rv) }));
    await this.ensureNetworkPolicies(networkingApi, namespace, name, labels, config, testAccess, !!buildJob);

    const url = `${config.tlsSecretName ? 'https' : 'http'}://${host}`;
    const extra = { runtimeKind: 'k8s', namespace, deployment: name, service: name, ingress: name, buildJob, buildRecordId, image, snapshotId: sourceSnapshot?.id, ...(requirement ? { requirementNo: requirement.requirementNo, serviceKey, fallbackEnvironment: 'test' } : {}), ...managedSecrets };
    try {
      await this.prisma.$transaction(async (tx) => {
        if (requirement) {
          await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${requirement.id}))`;
          const deployable = await tx.requirement.findFirst({ where: { id: requirement.id, status: { in: ['draft', 'active'] }, projects: { some: { projectId: session.projectId, serviceKey, developerId: userId, sessionId, changeRequired: true } } }, select: { id: true } });
          if (!deployable) throw new ConflictException({ code: 'REQUIREMENT_PREVIEW_STATE_CHANGED', message: '需求或关联项目状态已变化，本次预览部署已取消' });
        }
        await tx.previewInstance.upsert({
          where: { sessionId },
          create: { sessionId, kind: runtime.preview.kind, status: 'starting', url, containerPort: port, targetId: binding.targetId, targetName: binding.target.name, requirementId: requirement?.id, serviceKey, extra },
          update: { status: 'starting', url, hostPort: null, containerPort: port, targetId: binding.targetId, targetName: binding.target.name, requirementId: requirement?.id ?? null, serviceKey: serviceKey ?? null, logsTail: null, extra, lastActiveAt: new Date() },
        });
        if (requirement && serviceKey) await tx.requirementActivity.create({ data: { requirementId: requirement.id, actorId: userId, action: 'requirement.preview.started', detail: { serviceKey, projectId: session.projectId, sessionId, targetId: binding.targetId, namespace, deployment: name, ...(buildJob ? { buildJob } : {}) } } });
      });
      const starting = await this.prisma.previewInstance.findUnique({ where: { sessionId }, select: { id: true } });
      if (starting) await this.routing.sync(starting.id, 'starting', undefined, userId);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002' && requirement && serviceKey) {
        await Promise.allSettled([
          appsApi.deleteNamespacedDeployment({ name, namespace }),
          coreApi.deleteNamespacedService({ name, namespace }),
          networkingApi.deleteNamespacedIngress({ name, namespace }),
          networkingApi.deleteNamespacedNetworkPolicy({ name: `${name}-ingress`, namespace }),
          networkingApi.deleteNamespacedNetworkPolicy({ name: `${name}-egress`, namespace }),
          networkingApi.deleteNamespacedNetworkPolicy({ name: `${name}-test-egress`, namespace }),
          networkingApi.deleteNamespacedNetworkPolicy({ name: `${name}-build-egress`, namespace }),
          ...(buildJob ? [batchApi.deleteNamespacedJob({ name: buildJob, namespace, propagationPolicy: 'Background' })] : []),
          ...(managedSecrets.sourceSecret ? [coreApi.deleteNamespacedSecret({ name: managedSecrets.sourceSecret, namespace })] : []),
          ...(managedSecrets.registrySecret ? [coreApi.deleteNamespacedSecret({ name: managedSecrets.registrySecret, namespace })] : []),
        ]);
        if (buildRecordId) await this.finishBuild(buildRecordId, 'cancelled', '同一联调环境的服务标识被并发部署占用');
        await this.snapshots.remove(sourceSnapshot?.id);
        throw new ConflictException({ code: 'PREVIEW_SERVICE_KEY_CONFLICT', message: `该联调环境中服务 ${serviceKey} 已被并发部署占用` });
      }
      await Promise.allSettled([
        appsApi.deleteNamespacedDeployment({ name, namespace }),
        coreApi.deleteNamespacedService({ name, namespace }),
        networkingApi.deleteNamespacedIngress({ name, namespace }),
        networkingApi.deleteNamespacedNetworkPolicy({ name: `${name}-ingress`, namespace }),
        networkingApi.deleteNamespacedNetworkPolicy({ name: `${name}-egress`, namespace }),
        networkingApi.deleteNamespacedNetworkPolicy({ name: `${name}-test-egress`, namespace }),
        networkingApi.deleteNamespacedNetworkPolicy({ name: `${name}-build-egress`, namespace }),
        ...(buildJob ? [batchApi.deleteNamespacedJob({ name: buildJob, namespace, propagationPolicy: 'Background' })] : []),
        ...(managedSecrets.sourceSecret ? [coreApi.deleteNamespacedSecret({ name: managedSecrets.sourceSecret, namespace })] : []),
        ...(managedSecrets.registrySecret ? [coreApi.deleteNamespacedSecret({ name: managedSecrets.registrySecret, namespace })] : []),
      ]);
      await this.snapshots.remove(sourceSnapshot?.id);
      throw error;
    }
    return { status: 'starting', url, namespace, deployment: name, buildJob, image };
  }

  async status(userId: string, record: { id: string; sessionId: string; targetId: string | null; requirementId: string | null; serviceKey: string | null; containerPort: number | null; url: string | null; extra: Prisma.JsonValue | null }, touch = true) {
    const extra = record.extra as Record<string, string> | null;
    if (extra?.runtimeKind !== 'k8s' || !record.targetId) return null;
    const { appsApi, batchApi, coreApi } = await this.k8s.getAuthorizedClients(record.targetId, userId);
    try {
      if (extra.buildJob) {
        const job = await batchApi.readNamespacedJob({ name: extra.buildJob, namespace: extra.namespace }).catch((error) => {
          if (statusCode(error) === 404) return null;
          throw error;
        });
        if (job) {
          if (extra.buildRecordId) {
            const recordState = await this.prisma.previewBuildRecord.findUnique({ where: { id: extra.buildRecordId } });
            if (recordState?.status === 'queued') {
              const ahead = await this.prisma.previewBuildRecord.count({ where: { teamId: recordState.teamId, status: 'queued', queuedAt: { lt: recordState.queuedAt } } });
            await this.routing.sync(record.id, 'starting');
            return this.prisma.previewInstance.update({ where: { sessionId: record.sessionId }, data: { status: 'starting', logsTail: `构建任务排队中，前方 ${ahead} 个任务…`, ...(touch ? { lastActiveAt: new Date() } : {}) } });
            }
          }
          if (job.status?.conditions?.some((condition) => condition.type === 'Failed' && condition.status === 'True')) {
            const pods = await coreApi.listNamespacedPod({ namespace: extra.namespace, labelSelector: `job-name=${extra.buildJob}` });
            const podName = pods.items[0]?.metadata?.name;
            const logs = podName ? await coreApi.readNamespacedPodLog({ name: podName, namespace: extra.namespace, tailLines: 100 }).catch(() => '') : '';
            const logsTail = `镜像构建失败\n${String(logs).slice(-8000)}`;
            if (extra.buildRecordId) await this.finishBuild(extra.buildRecordId, 'failed', logsTail);
            if (extra.sourceSecret) await coreApi.deleteNamespacedSecret({ name: extra.sourceSecret, namespace: extra.namespace }).catch(() => undefined);
            await this.snapshots.remove(extra.snapshotId);
            await this.routing.sync(record.id, 'failed');
            return this.prisma.previewInstance.update({ where: { sessionId: record.sessionId }, data: { status: 'failed', logsTail, ...(touch ? { lastActiveAt: new Date() } : {}) } });
          }
          if ((job.status?.succeeded || 0) < 1) {
            await this.routing.sync(record.id, 'starting');
            return this.prisma.previewInstance.update({ where: { sessionId: record.sessionId }, data: { status: 'starting', logsTail: 'BuildKit 正在构建并推送预览镜像…', ...(touch ? { lastActiveAt: new Date() } : {}) } });
          }
          if (extra.buildRecordId) await this.finishBuild(extra.buildRecordId, 'succeeded');
          if (extra.sourceSecret) await coreApi.deleteNamespacedSecret({ name: extra.sourceSecret, namespace: extra.namespace }).catch((error) => { if (statusCode(error) !== 404) throw error; });
          await this.snapshots.remove(extra.snapshotId);
        }
      }
      const deployment = await appsApi.readNamespacedDeployment({ name: extra.deployment, namespace: extra.namespace });
      const failed = deployment.status?.conditions?.find((item) => item.type === 'Progressing' && item.reason === 'ProgressDeadlineExceeded');
      const status = (deployment.status?.readyReplicas || 0) >= 1 ? 'ready' : failed ? 'failed' : 'starting';
      const updated = await this.prisma.previewInstance.update({ where: { sessionId: record.sessionId }, data: { status, logsTail: failed?.message, ...(touch ? { lastActiveAt: new Date() } : {}) } });
      await this.routing.sync(record.id, status, { requirementId: record.requirementId, serviceKey: record.serviceKey, targetId: record.targetId, namespace: extra.namespace, serviceName: extra.service, port: record.containerPort || undefined, publicUrl: record.url });
      return updated;
    } catch (error) {
      if (statusCode(error) !== 404) throw error;
      await this.routing.sync(record.id, 'stopped');
      return this.prisma.previewInstance.update({ where: { sessionId: record.sessionId }, data: { status: 'stopped', url: null, logsTail: 'Kubernetes 预览资源已不存在。' } });
    }
  }

  async stop(userId: string, record: { id: string; sessionId: string; targetId: string | null; requirementId?: string | null; serviceKey?: string | null; extra: Prisma.JsonValue | null }, actorId?: string) {
    const extra = record.extra as Record<string, string> | null;
    if (extra?.runtimeKind !== 'k8s' || !record.targetId) return false;
    const { coreApi, appsApi, networkingApi, batchApi } = await this.k8s.getAuthorizedClients(record.targetId, userId);
    await Promise.allSettled([
      appsApi.deleteNamespacedDeployment({ name: extra.deployment, namespace: extra.namespace }),
      coreApi.deleteNamespacedService({ name: extra.service, namespace: extra.namespace }),
      networkingApi.deleteNamespacedIngress({ name: extra.ingress, namespace: extra.namespace }),
      networkingApi.deleteNamespacedNetworkPolicy({ name: `${extra.deployment}-ingress`, namespace: extra.namespace }),
      networkingApi.deleteNamespacedNetworkPolicy({ name: `${extra.deployment}-egress`, namespace: extra.namespace }),
      networkingApi.deleteNamespacedNetworkPolicy({ name: `${extra.deployment}-test-egress`, namespace: extra.namespace }),
      networkingApi.deleteNamespacedNetworkPolicy({ name: `${extra.deployment}-build-egress`, namespace: extra.namespace }),
      ...(extra.buildJob ? [batchApi.deleteNamespacedJob({ name: extra.buildJob, namespace: extra.namespace, propagationPolicy: 'Background' })] : []),
      ...(extra.sourceSecret ? [coreApi.deleteNamespacedSecret({ name: extra.sourceSecret, namespace: extra.namespace })] : []),
      ...(extra.registrySecret ? [coreApi.deleteNamespacedSecret({ name: extra.registrySecret, namespace: extra.namespace })] : []),
    ]);
    if (extra.buildRecordId) await this.finishBuild(extra.buildRecordId, 'cancelled');
    await this.snapshots.remove(extra.snapshotId);
    await this.routing.sync(record.id, 'stopped', undefined, actorId);
    await this.prisma.$transaction(async (tx) => {
      await tx.previewInstance.update({ where: { sessionId: record.sessionId }, data: { status: 'stopped', url: null, lastActiveAt: new Date() } });
      if (actorId && record.requirementId && record.serviceKey) await tx.requirementActivity.create({ data: { requirementId: record.requirementId, actorId, action: 'requirement.preview.stopped', detail: { serviceKey: record.serviceKey, sessionId: record.sessionId } } });
    });
    return true;
  }

  async listBuilds(sessionId: string, query: PreviewBuildQueryDto) {
    const where = { sessionId };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.previewBuildRecord.findMany({ where, orderBy: { createdAt: 'desc' }, ...pageArgs(query) }),
      this.prisma.previewBuildRecord.count({ where }),
    ]);
    return pageResult(items, total, query);
  }

  async cancelBuild(userId: string, sessionId: string, buildId: string) {
    const row = await this.prisma.previewBuildRecord.findFirst({ where: { id: buildId, sessionId, userId } });
    if (!row) throw new BadRequestException('构建记录不存在或无权取消');
    if (!['queued', 'building'].includes(row.status)) return row;
    await this.cancelRecord(row, '用户主动取消构建');
    return this.prisma.previewBuildRecord.findUnique({ where: { id: row.id } });
  }

  async adminBuilds(query: AdminPreviewBuildQueryDto) {
    const where = query.status ? { status: query.status } : {};
    const [items, total, groups] = await Promise.all([
      this.prisma.previewBuildRecord.findMany({ where, orderBy: { queuedAt: 'desc' }, ...pageArgs(query) }),
      this.prisma.previewBuildRecord.count({ where }),
      this.prisma.previewBuildRecord.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);
    return { ...pageResult(items, total, query), statuses: Object.fromEntries(groups.map((group) => [group.status, group._count._all])) };
  }

  async adminCancel(buildId: string) {
    const row = await this.prisma.previewBuildRecord.findUnique({ where: { id: buildId } });
    if (!row) throw new BadRequestException('构建记录不存在');
    if (['queued', 'building'].includes(row.status)) await this.cancelRecord(row, '管理员强制取消构建');
    return this.prisma.previewBuildRecord.findUnique({ where: { id: buildId } });
  }

  async buildMetrics(projectId: string, days = 7) {
    const boundedDays = Math.min(90, Math.max(1, days));
    const rows = await this.prisma.previewBuildRecord.findMany({ where: { projectId, createdAt: { gte: new Date(Date.now() - boundedDays * 86_400_000) } }, orderBy: { createdAt: 'desc' }, take: 1000 });
    const completed = rows.filter((row) => row.status === 'succeeded' || row.status === 'failed');
    const succeeded = completed.filter((row) => row.status === 'succeeded').length;
    const durations = completed.map((row) => row.durationMs).filter((value): value is number => value !== null);
    return { windowDays: boundedDays, total: rows.length, queued: rows.filter((row) => row.status === 'queued').length, building: rows.filter((row) => row.status === 'building').length, completed: completed.length, succeeded, failed: completed.length - succeeded, successRate: completed.length ? succeeded / completed.length * 100 : 0, averageDurationMs: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : 0, latest: rows.slice(0, 20) };
  }

  private reserveBuild(input: { sessionId: string; projectId: string; userId: string; teamId: string; targetId: string; namespace: string; jobName: string; image: string }) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(783292)`;
      const [teamActive, userActive] = await Promise.all([
        tx.previewBuildRecord.count({ where: { teamId: input.teamId, status: 'building' } }),
        tx.previewBuildRecord.count({ where: { userId: input.userId, status: 'building' } }),
      ]);
      const canStart = teamActive < Number(this.config.get('PREVIEW_BUILD_MAX_PER_TEAM', 4)) && userActive < Number(this.config.get('PREVIEW_BUILD_MAX_PER_USER', 2));
      return tx.previewBuildRecord.create({ data: { ...input, status: canStart ? 'building' : 'queued', startedAt: canStart ? new Date() : null } });
    });
  }

  private async maintainBuildQueue() {
    const queueDeadline = new Date(Date.now() - Number(this.config.get('PREVIEW_BUILD_QUEUE_TIMEOUT_MINUTES', 30)) * 60_000);
    const expired = await this.prisma.previewBuildRecord.findMany({ where: { status: 'queued', queuedAt: { lt: queueDeadline } }, take: 50 });
    for (const row of expired) await this.cancelRecord(row, '构建排队超时，已自动取消');
    const active = await this.prisma.previewBuildRecord.findMany({ where: { status: 'building' }, orderBy: { startedAt: 'asc' }, take: 50 });
    for (const row of active) {
      try {
        const { batchApi, coreApi } = await this.k8s.getAuthorizedClients(row.targetId, row.userId);
        const job = await batchApi.readNamespacedJob({ name: row.jobName, namespace: row.namespace });
        const succeeded = job.status?.conditions?.some((condition) => condition.type === 'Complete' && condition.status === 'True');
        const failed = job.status?.conditions?.some((condition) => condition.type === 'Failed' && condition.status === 'True');
        if (succeeded) {
          await this.finishBuild(row.id, 'succeeded');
          const preview = await this.prisma.previewInstance.findUnique({ where: { sessionId: row.sessionId }, select: { extra: true } });
          const extra = preview?.extra as Record<string, string> | null;
          if (extra?.sourceSecret) await coreApi.deleteNamespacedSecret({ name: extra.sourceSecret, namespace: row.namespace }).catch((error) => { if (statusCode(error) !== 404) throw error; });
          await this.snapshots.remove(extra?.snapshotId);
        } else if (failed) {
          const pods = await coreApi.listNamespacedPod({ namespace: row.namespace, labelSelector: `job-name=${row.jobName}` });
          const podName = pods.items[0]?.metadata?.name;
          const logs = podName ? await coreApi.readNamespacedPodLog({ name: podName, namespace: row.namespace, tailLines: 100 }).catch(() => '') : '';
          await this.finishBuild(row.id, 'failed', String(logs).slice(-8000));
          const preview = await this.prisma.previewInstance.findUnique({ where: { sessionId: row.sessionId }, select: { extra: true } });
          const extra = preview?.extra as Record<string, string> | null;
          if (extra?.sourceSecret) await coreApi.deleteNamespacedSecret({ name: extra.sourceSecret, namespace: row.namespace }).catch(() => undefined);
          await this.snapshots.remove(extra?.snapshotId);
        }
      } catch (error) {
        const missingGraceMs = Number(this.config.get('PREVIEW_BUILD_STUCK_GRACE_SECONDS', 120)) * 1_000;
        if (statusCode(error) === 404 && row.startedAt && Date.now() - row.startedAt.getTime() > missingGraceMs) {
          await this.finishBuild(row.id, 'failed', 'BuildKit Job 已不存在，无法确认构建结果');
        } else if (statusCode(error) !== 404) {
          this.logger.warn(`检查构建状态失败 job=${row.jobName}: ${error}`);
        }
      }
    }
    await this.dispatchQueued();
  }

  private async cancelRecord(row: { id: string; sessionId: string; targetId: string; userId: string; namespace: string; jobName: string }, reason: string) {
    const preview = await this.prisma.previewInstance.findUnique({ where: { sessionId: row.sessionId } });
    if (preview && (preview.extra as Record<string, unknown> | null)?.buildRecordId === row.id) {
      await this.stop(row.userId, preview);
      await this.prisma.previewInstance.update({ where: { id: preview.id }, data: { logsTail: reason } });
      return;
    }
    try {
      const { batchApi } = await this.k8s.getAuthorizedClients(row.targetId, row.userId);
      await batchApi.deleteNamespacedJob({ name: row.jobName, namespace: row.namespace, propagationPolicy: 'Background' }).catch((error) => { if (statusCode(error) !== 404) throw error; });
    } finally {
      await this.finishBuild(row.id, 'cancelled', reason);
    }
  }

  private async dispatchQueued() {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const next = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(783292)`;
        const candidates = await tx.previewBuildRecord.findMany({ where: { status: 'queued' }, orderBy: { queuedAt: 'asc' }, take: 50 });
        for (const candidate of candidates) {
          const [teamActive, userActive] = await Promise.all([
            tx.previewBuildRecord.count({ where: { teamId: candidate.teamId, status: 'building' } }),
            tx.previewBuildRecord.count({ where: { userId: candidate.userId, status: 'building' } }),
          ]);
          if (teamActive >= Number(this.config.get('PREVIEW_BUILD_MAX_PER_TEAM', 4)) || userActive >= Number(this.config.get('PREVIEW_BUILD_MAX_PER_USER', 2))) continue;
          return tx.previewBuildRecord.update({ where: { id: candidate.id }, data: { status: 'building', startedAt: new Date() } });
        }
        return null;
      });
      if (!next) return;
      try {
        const { batchApi } = await this.k8s.getAuthorizedClients(next.targetId, next.userId);
        await batchApi.patchNamespacedJob(
          { name: next.jobName, namespace: next.namespace, body: { spec: { suspend: false } } },
          k8s.setHeaderOptions('Content-Type', 'application/merge-patch+json'),
        );
        this.logger.log(`已调度预览构建 job=${next.jobName}`);
      } catch (error) {
        await this.finishBuild(next.id, 'failed', `恢复 BuildKit Job 失败: ${(error as Error).message}`);
      }
    }
  }

  private async finishBuild(id: string, status: 'succeeded' | 'failed' | 'cancelled', logsTail?: string) {
    const row = await this.prisma.previewBuildRecord.findUnique({ where: { id } });
    if (!row || !['queued', 'building'].includes(row.status)) return;
    const finishedAt = new Date();
    await this.prisma.previewBuildRecord.update({ where: { id }, data: { status, logsTail, finishedAt, durationMs: row.startedAt ? Math.max(0, finishedAt.getTime() - row.startedAt.getTime()) : null } });
  }

  private async ensureBuildSecrets(coreApi: k8s.CoreV1Api, namespace: string, name: string, userId: string, config: PreviewBindingConfig, image: string, source?: { url: string; token: string; sha256: string }) {
    let registrySecret: string | undefined;
    if (config.registryId) {
      const row = await this.prisma.registry.findFirst({ where: { id: config.registryId, userId } });
      if (!row) throw new BadRequestException('镜像仓库不存在或不属于当前用户');
      const registry = JSON.parse(this.crypto.decrypt(row.encryptedConfig)) as { url: string; username: string; password: string; insecure?: boolean };
      if (registry.insecure) throw new BadRequestException('Kubernetes 预览自动构建仅支持 TLS 镜像仓库');
      const registryHost = registry.url.replace(/^https?:\/\//, '').replace(/\/+$/, '').split('/')[0];
      if (!image.startsWith(`${registryHost}/`)) throw new BadRequestException('预览镜像地址与所选 Registry 不匹配');
      registrySecret = `${name}-registry`;
      const dockerConfig = { auths: { [registryHost]: { username: registry.username, password: registry.password, auth: Buffer.from(`${registry.username}:${registry.password}`).toString('base64') } } };
      await upsert(
        () => coreApi.readNamespacedSecret({ name: registrySecret!, namespace }),
        () => coreApi.createNamespacedSecret({ namespace, body: { metadata: { name: registrySecret, namespace, labels: { 'app.kubernetes.io/managed-by': 'codegen-platform', 'codegen.io/preview-id': name } }, type: 'kubernetes.io/dockerconfigjson', stringData: { '.dockerconfigjson': JSON.stringify(dockerConfig) } } }),
        (rv) => coreApi.replaceNamespacedSecret({ name: registrySecret!, namespace, body: { metadata: { name: registrySecret, namespace, resourceVersion: rv, labels: { 'app.kubernetes.io/managed-by': 'codegen-platform', 'codegen.io/preview-id': name } }, type: 'kubernetes.io/dockerconfigjson', stringData: { '.dockerconfigjson': JSON.stringify(dockerConfig) } } }),
      );
    }

    let sourceSecret: string | undefined;
    if (source) {
      sourceSecret = `${name}-source`;
      await upsert(
        () => coreApi.readNamespacedSecret({ name: sourceSecret!, namespace }),
        () => coreApi.createNamespacedSecret({ namespace, body: { metadata: { name: sourceSecret, namespace, labels: { 'app.kubernetes.io/managed-by': 'codegen-platform', 'codegen.io/preview-id': name } }, type: 'Opaque', stringData: { url: source.url, token: source.token, sha256: source.sha256 } } }),
        (rv) => coreApi.replaceNamespacedSecret({ name: sourceSecret!, namespace, body: { metadata: { name: sourceSecret, namespace, resourceVersion: rv, labels: { 'app.kubernetes.io/managed-by': 'codegen-platform', 'codegen.io/preview-id': name } }, type: 'Opaque', stringData: { url: source.url, token: source.token, sha256: source.sha256 } } }),
      );
    }
    return { registrySecret, sourceSecret };
  }

  private async resolveTestService(coreApi: k8s.CoreV1Api, namespace: string, serviceName: string, port: number) {
    let service: k8s.V1Service;
    try {
      service = await coreApi.readNamespacedService({ name: serviceName, namespace });
    } catch (error) {
      if (statusCode(error) === 404) throw new BadRequestException({ code: 'PREVIEW_TEST_SERVICE_NOT_FOUND', message: `测试 Service ${namespace}/${serviceName} 不存在` });
      throw error;
    }
    const podLabels = service.spec?.selector;
    if (!podLabels || !Object.keys(podLabels).length) {
      throw new BadRequestException({ code: 'PREVIEW_TEST_SERVICE_SELECTOR_REQUIRED', message: `测试 Service ${namespace}/${serviceName} 必须配置 Pod selector` });
    }
    const servicePort = service.spec?.ports?.find((item) => item.port === port);
    if (!servicePort) {
      throw new BadRequestException({ code: 'PREVIEW_TEST_SERVICE_PORT_INVALID', message: `测试 Service ${namespace}/${serviceName} 未声明端口 ${port}` });
    }
    return { namespace, serviceName, podLabels, port, networkPort: servicePort.targetPort ?? servicePort.port };
  }

  private async ensureNetworkPolicies(api: k8s.NetworkingV1Api, namespace: string, name: string, labels: Record<string, string>, config: PreviewBindingConfig, testAccess: { namespace: string; serviceName: string; podLabels: Record<string, string>; port: number; networkPort: number | string } | undefined, hasBuildJob: boolean) {
    const selector = { matchLabels: { 'app.kubernetes.io/instance': name, 'app.kubernetes.io/component': 'preview-runtime' } };
    const ingressSources: k8s.V1NetworkPolicyPeer[] = [
      { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': config.ingressNamespace || 'ingress-nginx' } }, podSelector: { matchLabels: config.ingressPodLabels || { 'app.kubernetes.io/name': 'ingress-nginx' } } },
      ...(testAccess ? [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': testAccess.namespace } }, podSelector: { matchLabels: testAccess.podLabels } }] : []),
    ];
    const ingress: k8s.V1NetworkPolicy = { metadata: { name: `${name}-ingress`, namespace, labels }, spec: { podSelector: selector, policyTypes: ['Ingress'], ingress: [{ _from: ingressSources }] } };
    await upsert(() => api.readNamespacedNetworkPolicy({ name: ingress.metadata!.name!, namespace }), () => api.createNamespacedNetworkPolicy({ namespace, body: ingress }), (rv) => api.replaceNamespacedNetworkPolicy({ name: ingress.metadata!.name!, namespace, body: withVersion(ingress, rv) }));
    if (testAccess) {
      const testEgress: k8s.V1NetworkPolicy = { metadata: { name: `${name}-test-egress`, namespace, labels }, spec: { podSelector: selector, policyTypes: ['Egress'], egress: [{ to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': testAccess.namespace } }, podSelector: { matchLabels: testAccess.podLabels } }], ports: [{ protocol: 'TCP', port: testAccess.networkPort }] }] } };
      await upsert(() => api.readNamespacedNetworkPolicy({ name: testEgress.metadata!.name!, namespace }), () => api.createNamespacedNetworkPolicy({ namespace, body: testEgress }), (rv) => api.replaceNamespacedNetworkPolicy({ name: testEgress.metadata!.name!, namespace, body: withVersion(testEgress, rv) }));
    } else {
      await api.deleteNamespacedNetworkPolicy({ name: `${name}-test-egress`, namespace }).catch((error) => { if (statusCode(error) !== 404) throw error; });
    }
    if (config.allowInternet) {
      const egress: k8s.V1NetworkPolicy = { metadata: { name: `${name}-egress`, namespace, labels }, spec: { podSelector: selector, policyTypes: ['Egress'], egress: [{ to: [{ ipBlock: { cidr: '0.0.0.0/0', except: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'] } }] }] } };
      await upsert(() => api.readNamespacedNetworkPolicy({ name: egress.metadata!.name!, namespace }), () => api.createNamespacedNetworkPolicy({ namespace, body: egress }), (rv) => api.replaceNamespacedNetworkPolicy({ name: egress.metadata!.name!, namespace, body: withVersion(egress, rv) }));
    } else {
      await api.deleteNamespacedNetworkPolicy({ name: `${name}-egress`, namespace }).catch((error) => { if (statusCode(error) !== 404) throw error; });
    }
    if (hasBuildJob && config.buildAllowInternet !== false) {
      const ipBlocks = config.buildEgressCidrs?.length
        ? config.buildEgressCidrs.map((cidr) => ({ ipBlock: { cidr } }))
        : [{ ipBlock: { cidr: '0.0.0.0/0', except: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'] } }];
      const buildEgress: k8s.V1NetworkPolicy = { metadata: { name: `${name}-build-egress`, namespace, labels }, spec: { podSelector: { matchLabels: { 'app.kubernetes.io/instance': name, 'app.kubernetes.io/component': 'preview-build' } }, policyTypes: ['Egress'], egress: [{ to: ipBlocks }] } };
      await upsert(() => api.readNamespacedNetworkPolicy({ name: buildEgress.metadata!.name!, namespace }), () => api.createNamespacedNetworkPolicy({ namespace, body: buildEgress }), (rv) => api.replaceNamespacedNetworkPolicy({ name: buildEgress.metadata!.name!, namespace, body: withVersion(buildEgress, rv) }));
    } else {
      await api.deleteNamespacedNetworkPolicy({ name: `${name}-build-egress`, namespace }).catch((error) => { if (statusCode(error) !== 404) throw error; });
    }
  }

  private async reconcileRoutes() {
    await this.routing.removeExpired();
    const rows = await this.prisma.previewInstance.findMany({
      where: { status: { in: ['starting', 'ready'] }, requirementId: { not: null }, requirement: { status: { in: ['draft', 'active'] } }, extra: { path: ['runtimeKind'], equals: 'k8s' } },
      select: { id: true, sessionId: true, targetId: true, requirementId: true, serviceKey: true, containerPort: true, url: true, extra: true, session: { select: { userId: true } } },
      take: 200,
    });
    for (let offset = 0; offset < rows.length; offset += 10) {
      await Promise.all(rows.slice(offset, offset + 10).map((row) =>
        this.status(row.session.userId, row, false).catch((error) => this.logger.warn(`需求预览路由校准失败 session=${row.sessionId}: ${(error as Error).message}`)),
      ));
    }
  }

  private async reapExpired() {
    await this.snapshots.reapExpired();
    const ttlMs = Number(this.config.get('K8S_PREVIEW_TTL_MINUTES', 60)) * 60_000;
    if (ttlMs <= 0) return;
    const rows = await this.prisma.previewInstance.findMany({
      where: { status: { in: ['starting', 'ready', 'failed'] }, lastActiveAt: { lt: new Date(Date.now() - ttlMs) } },
      include: { session: { select: { userId: true } } },
    });
    for (const row of rows) {
      const extra = row.extra as Record<string, unknown> | null;
      if (extra?.runtimeKind !== 'k8s') continue;
      try {
        await this.stop(row.session.userId, row);
        this.logger.log(`已回收过期 K8s 预览 session=${row.sessionId}`);
      } catch (error) {
        this.logger.warn(`K8s 预览回收失败 session=${row.sessionId}: ${error}`);
      }
    }
  }
}

export function validatePreviewBindingConfig(value: unknown): PreviewBindingConfig {
  const config = (value || {}) as Record<string, unknown>;
  const imagePattern = /^[\w./:@-]+$/;
  if (config.image !== undefined && (typeof config.image !== 'string' || !imagePattern.test(config.image))) throw new BadRequestException('Kubernetes 预览 image 格式非法');
  if (config.imageRepository !== undefined && (typeof config.imageRepository !== 'string' || !/^[\w./-]+$/.test(config.imageRepository))) throw new BadRequestException('Kubernetes 预览 imageRepository 格式非法');
  if (!config.image && !config.imageRepository) throw new BadRequestException('Kubernetes 预览必须配置 image 或 imageRepository');
  if (config.dockerfile !== undefined && (typeof config.dockerfile !== 'string' || !/^[A-Za-z0-9_./-]{1,200}$/.test(config.dockerfile))) throw new BadRequestException('Kubernetes 预览 dockerfile 格式非法');
  if (config.buildkitImage !== undefined && (typeof config.buildkitImage !== 'string' || !imagePattern.test(config.buildkitImage))) throw new BadRequestException('Kubernetes 预览 buildkitImage 格式非法');
  if (config.snapshotDownloaderImage !== undefined && (typeof config.snapshotDownloaderImage !== 'string' || !imagePattern.test(config.snapshotDownloaderImage))) throw new BadRequestException('Kubernetes 预览 snapshotDownloaderImage 格式非法');
  if (config.sourceBaseUrl !== undefined && (typeof config.sourceBaseUrl !== 'string' || !/^https:\/\/[A-Za-z0-9._~:/-]+$/.test(config.sourceBaseUrl))) throw new BadRequestException('Kubernetes 预览 sourceBaseUrl 必须是目标集群可访问的 HTTPS 地址');
  if (config.registryId !== undefined && (typeof config.registryId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(config.registryId))) throw new BadRequestException('Kubernetes 预览 registryId 格式非法');
  if (typeof config.baseDomain !== 'string' || !/^[a-z0-9.-]+$/i.test(config.baseDomain)) throw new BadRequestException('Kubernetes 预览绑定必须配置合法 baseDomain');
  if (config.startCommand !== undefined && (typeof config.startCommand !== 'string' || !config.startCommand.trim() || config.startCommand.length > 1000)) throw new BadRequestException('Kubernetes 预览 startCommand 格式非法');
  if (config.testNamespace !== undefined && (typeof config.testNamespace !== 'string' || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(config.testNamespace) || config.testNamespace.length > 63)) throw new BadRequestException('Kubernetes 预览 testNamespace 格式非法');
  if (config.testServiceName !== undefined && (typeof config.testServiceName !== 'string' || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(config.testServiceName) || config.testServiceName.length > 63)) throw new BadRequestException('Kubernetes 预览 testServiceName 格式非法');
  for (const key of ['ingressClassName', 'ingressNamespace', 'tlsSecretName', 'imagePullSecret', 'registryAuthSecret']) {
    const field = config[key];
    if (field !== undefined && (typeof field !== 'string' || !/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/i.test(field))) throw new BadRequestException(`Kubernetes 预览 ${key} 格式非法`);
  }
  for (const key of ['allowInternet', 'buildAllowInternet']) {
    if (config[key] !== undefined && typeof config[key] !== 'boolean') throw new BadRequestException(`Kubernetes 预览 ${key} 必须是布尔值`);
  }
  if (config.env !== undefined) {
    if (!config.env || typeof config.env !== 'object' || Array.isArray(config.env)) throw new BadRequestException('Kubernetes 预览 env 必须是字符串键值对象');
    for (const [key, value] of Object.entries(config.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string') throw new BadRequestException(`Kubernetes 预览环境变量非法: ${key}`);
    }
  }
  if (config.buildEgressCidrs !== undefined && (!Array.isArray(config.buildEgressCidrs) || config.buildEgressCidrs.some((cidr) => typeof cidr !== 'string' || !/^(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(cidr)))) {
    throw new BadRequestException('Kubernetes 预览 buildEgressCidrs 必须是 IPv4 CIDR 数组');
  }
  const buildRetries = config.buildRetries;
  if (buildRetries !== undefined && (typeof buildRetries !== 'number' || !Number.isInteger(buildRetries) || buildRetries < 0 || buildRetries > 3)) throw new BadRequestException('Kubernetes 预览 buildRetries 必须是 0-3 的整数');
  const buildTimeoutSeconds = config.buildTimeoutSeconds;
  if (buildTimeoutSeconds !== undefined && (typeof buildTimeoutSeconds !== 'number' || !Number.isInteger(buildTimeoutSeconds) || buildTimeoutSeconds < 60 || buildTimeoutSeconds > 3600)) throw new BadRequestException('Kubernetes 预览 buildTimeoutSeconds 必须是 60-3600 的整数');
  if (config.testServicePort !== undefined && (typeof config.testServicePort !== 'number' || !Number.isInteger(config.testServicePort) || config.testServicePort < 1 || config.testServicePort > 65535)) throw new BadRequestException('Kubernetes 预览 testServicePort 必须是 1-65535 的整数');
  return config as unknown as PreviewBindingConfig;
}

function buildkitJob(name: string, namespace: string, labels: Record<string, string>, config: PreviewBindingConfig, image: string, managedRegistrySecret?: string, sourceSecret?: string, suspended = false): k8s.V1Job {
  const dockerfile = config.dockerfile || 'Dockerfile';
  const repository = config.imageRepository!;
  return {
    metadata: { name, namespace, labels },
    spec: {
      suspend: suspended, backoffLimit: config.buildRetries ?? 1, activeDeadlineSeconds: config.buildTimeoutSeconds ?? 1200, ttlSecondsAfterFinished: 3600,
      template: {
        metadata: { labels: { ...labels, 'app.kubernetes.io/component': 'preview-build' } },
        spec: {
          restartPolicy: 'Never', serviceAccountName: 'codegen-preview', automountServiceAccountToken: false,
          imagePullSecrets: (managedRegistrySecret || config.imagePullSecret) ? [{ name: managedRegistrySecret || config.imagePullSecret! }] : undefined,
          securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
          containers: [{
            name: 'buildkit', image: config.buildkitImage || 'moby/buildkit:rootless',
            command: ['buildctl-daemonless.sh'],
            args: ['build', '--frontend', 'dockerfile.v0', '--local', 'context=/workspace', '--local', 'dockerfile=/workspace', '--opt', `filename=${dockerfile}`, '--output', `type=image,name=${image},push=true`, '--export-cache', `type=registry,ref=${repository}:buildcache,mode=max`, '--import-cache', `type=registry,ref=${repository}:buildcache`],
            env: [{ name: 'BUILDKITD_FLAGS', value: '--oci-worker-no-process-sandbox' }],
            resources: { requests: { cpu: '500m', memory: '1Gi' }, limits: { cpu: '4', memory: '8Gi' } },
            securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, runAsNonRoot: true, runAsUser: 1000 },
            volumeMounts: [
              ...((managedRegistrySecret || config.registryAuthSecret) ? [{ name: 'registry-auth', mountPath: '/home/user/.docker', readOnly: true }] : []),
              { name: 'source', mountPath: '/workspace', readOnly: true },
            ],
          }],
          initContainers: sourceSecret ? [{
            name: 'download-source', image: config.snapshotDownloaderImage || 'alpine:3.20', imagePullPolicy: 'IfNotPresent',
            command: ['sh', '-ec', 'wget -q --header="Authorization: Bearer ${SOURCE_TOKEN}" -O /tmp/source.tar.gz "${SOURCE_URL}" && echo "${SOURCE_SHA256}  /tmp/source.tar.gz" | sha256sum -c - && tar -xzf /tmp/source.tar.gz -C /workspace'],
            env: [
              { name: 'SOURCE_URL', valueFrom: { secretKeyRef: { name: sourceSecret, key: 'url' } } },
              { name: 'SOURCE_TOKEN', valueFrom: { secretKeyRef: { name: sourceSecret, key: 'token' } } },
              { name: 'SOURCE_SHA256', valueFrom: { secretKeyRef: { name: sourceSecret, key: 'sha256' } } },
            ],
            resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { cpu: '500m', memory: '512Mi' } },
            securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, runAsNonRoot: true, runAsUser: 1000, readOnlyRootFilesystem: true },
            volumeMounts: [{ name: 'source', mountPath: '/workspace' }, { name: 'source-tmp', mountPath: '/tmp' }],
          }] : undefined,
          volumes: [
            ...((managedRegistrySecret || config.registryAuthSecret) ? [{ name: 'registry-auth', secret: { secretName: managedRegistrySecret || config.registryAuthSecret!, items: [{ key: '.dockerconfigjson', path: 'config.json' }] } }] : []),
            { name: 'source', emptyDir: { sizeLimit: '512Mi' } },
            { name: 'source-tmp', emptyDir: { sizeLimit: '256Mi' } },
          ],
        },
      },
    },
  };
}

function resourceName(sessionId: string) { return `preview-${sessionId.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 54)}`.replace(/-+$/g, ''); }
function routeHostLabel(serviceKey: string, requirementNo: string) {
  const digest = createHash('sha256').update(serviceKey).digest('hex').slice(0, 8);
  return `${serviceKey.slice(0, 16).replace(/[.-]+$/g, '')}-${requirementNo.slice(0, 28).replace(/-+$/g, '')}-${digest}`;
}
function withVersion<T extends { metadata?: k8s.V1ObjectMeta }>(body: T, resourceVersion: string): T { return { ...body, metadata: { ...body.metadata, resourceVersion } }; }
async function upsert<T extends { metadata?: { resourceVersion?: string } }>(read: () => Promise<T>, create: () => Promise<unknown>, replace: (version: string) => Promise<unknown>) { try { const current = await read(); await replace(current.metadata?.resourceVersion || ''); } catch (error) { if (statusCode(error) !== 404) throw error; await create(); } }
function statusCode(error: unknown) { const value = error as { code?: number; statusCode?: number; response?: { statusCode?: number } }; return value.code || value.statusCode || value.response?.statusCode; }
