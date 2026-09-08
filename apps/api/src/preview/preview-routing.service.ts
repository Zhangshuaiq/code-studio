import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { previewNamespaceName } from '../k8s/k8s.service';

@Injectable()
export class PreviewRoutingService {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService, private readonly crypto: CryptoService) {}

  authorize(value?: string) {
    const expected = this.config.get<string>('PREVIEW_ROUTING_CONTROL_TOKEN', '').trim();
    if (expected.length < 32) throw new ServiceUnavailableException({ code: 'PREVIEW_ROUTING_NOT_CONFIGURED', message: '预览路由控制面尚未配置' });
    const actual = value?.trim() || '';
    const left = Buffer.from(actual); const right = Buffer.from(expected);
    if (left.length !== right.length || !timingSafeEqual(left, right)) throw new UnauthorizedException({ code: 'PREVIEW_ROUTING_UNAUTHORIZED', message: '路由控制面凭证无效' });
  }

  async sync(previewInstanceId: string, status: string, detail?: { requirementId?: string | null; serviceKey?: string | null; targetId?: string | null; namespace?: string; serviceName?: string; port?: number; publicUrl?: string | null }, actorId?: string) {
    if (status !== 'ready' || !detail?.requirementId || !detail.serviceKey || !detail.targetId || !detail.namespace || !detail.serviceName || !detail.port) {
      const current = await this.prisma.requirementRouteEndpoint.findUnique({ where: { previewInstanceId }, select: { requirementId: true, serviceKey: true } });
      await this.prisma.$transaction([
        this.prisma.requirementRouteEndpoint.deleteMany({ where: { previewInstanceId } }),
        ...(current ? [this.prisma.requirementProject.updateMany({ where: { requirementId: current.requirementId, serviceKey: current.serviceKey, status: 'preview' }, data: { status: 'developing' } })] : []),
        ...(current ? [this.prisma.requirementActivity.create({ data: { requirementId: current.requirementId, actorId, action: 'requirement.preview.removed', detail: { serviceKey: current.serviceKey, status } } })] : []),
      ]);
      return;
    }
    const instance = await this.prisma.previewInstance.findUnique({
      where: { id: previewInstanceId },
      select: {
        id: true, sessionId: true, status: true, requirementId: true, serviceKey: true, targetId: true,
        session: { select: { projectId: true } },
        requirement: { select: { status: true, teamId: true, projects: { select: { projectId: true, serviceKey: true, sessionId: true, changeRequired: true } } } },
      },
    });
    let expectedNamespace: string | null = null;
    try { if (instance?.requirement) expectedNamespace = previewNamespaceName(this.config.get('PREVIEW_NAMESPACE_PREFIX', 'codegen-preview'), instance.requirement.teamId); } catch { /* 非法平台配置不能产生路由端点 */ }
    const linked = instance?.requirement?.projects.some((item) => item.projectId === instance.session.projectId && item.serviceKey === instance.serviceKey && item.sessionId === instance.sessionId && item.changeRequired);
    const canonical = instance
      && instance.status === 'ready'
      && instance.requirementId && instance.serviceKey && instance.targetId
      && instance.requirement && ['draft', 'active'].includes(instance.requirement.status)
      && linked
      && detail.requirementId === instance.requirementId
      && detail.serviceKey === instance.serviceKey
      && detail.targetId === instance.targetId
      && detail.namespace === expectedNamespace
      && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(detail.serviceName)
      && detail.serviceName.length <= 63
      && Number.isInteger(detail.port) && detail.port >= 1 && detail.port <= 65535;
    if (!canonical) return this.sync(previewInstanceId, 'invalid');
    const configuredLeaseSeconds = Number(this.config.get('PREVIEW_ROUTE_LEASE_SECONDS', 90));
    const leaseSeconds = Number.isInteger(configuredLeaseSeconds) ? Math.min(300, Math.max(30, configuredLeaseSeconds)) : 90;
    const data = { requirementId: instance.requirementId!, serviceKey: instance.serviceKey!, targetId: instance.targetId!, namespace: detail.namespace, serviceName: detail.serviceName, port: detail.port, endpointUrl: `http://${detail.serviceName}.${detail.namespace}.svc.cluster.local:${detail.port}`, publicUrl: detail.publicUrl || null, leaseExpiresAt: new Date(Date.now() + leaseSeconds * 1_000) };
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${instance.requirementId!}))`;
      const stillReady = await tx.previewInstance.findFirst({
        where: {
          id: previewInstanceId, status: 'ready', requirementId: instance.requirementId!, serviceKey: instance.serviceKey!, targetId: instance.targetId!,
          session: { projectId: instance.session.projectId },
          requirement: { status: { in: ['draft', 'active'] }, projects: { some: { projectId: instance.session.projectId, serviceKey: instance.serviceKey!, sessionId: instance.sessionId, changeRequired: true } } },
        },
        select: { id: true },
      });
      if (!stillReady) {
        await tx.requirementRouteEndpoint.deleteMany({ where: { previewInstanceId } });
        return;
      }
      const current = await tx.requirementRouteEndpoint.findUnique({ where: { previewInstanceId }, select: { id: true } });
      await tx.requirementRouteEndpoint.deleteMany({ where: { requirementId: instance.requirementId!, serviceKey: instance.serviceKey!, previewInstanceId: { not: previewInstanceId } } });
      await tx.requirementRouteEndpoint.upsert({ where: { previewInstanceId }, create: { previewInstanceId, ...data }, update: data });
      await tx.requirementProject.updateMany({ where: { requirementId: instance.requirementId!, serviceKey: instance.serviceKey!, sessionId: instance.sessionId, changeRequired: true }, data: { status: 'preview' } });
      if (!current) await tx.requirementActivity.create({ data: { requirementId: instance.requirementId!, action: 'requirement.preview.ready', detail: { serviceKey: instance.serviceKey!, targetId: instance.targetId!, namespace: detail.namespace, serviceName: detail.serviceName, port: detail.port } } });
    });
  }

  async resolve(requirementNo: string, serviceKey: string) {
    const requirement = await this.prisma.requirement.findFirst({
      where: { requirementNo: requirementNo.toUpperCase(), status: { in: ['draft', 'active'] } },
      select: {
        id: true, requirementNo: true, teamId: true,
        projects: { where: { serviceKey: serviceKey.toLowerCase() }, take: 1, select: { serviceKey: true, project: { select: { runtimeBindings: { where: { purpose: 'preview', environment: 'preview', enabled: true }, take: 1, select: { targetId: true, config: true, target: { select: { kind: true, enabled: true, purposes: true, encryptedConfig: true } } } } } } } },
        routeEndpoints: {
          where: { serviceKey: serviceKey.toLowerCase(), leaseExpiresAt: { gt: new Date() }, previewInstance: { status: 'ready' } },
          take: 1,
          select: {
            targetId: true, namespace: true, serviceName: true, port: true, publicUrl: true, leaseExpiresAt: true,
            previewInstance: { select: { requirementId: true, serviceKey: true, targetId: true } },
          },
        },
      },
    });
    const linked = requirement?.projects[0];
    if (!requirement || !linked) return { version: 1, route: 'not_found', requirementNo: requirementNo.toUpperCase(), serviceKey: serviceKey.toLowerCase(), retryToFallback: false, cacheTtlSeconds: 5 };
    const binding = linked.project.runtimeBindings[0];
    if (!binding || binding.target.kind !== 'k8s' || !binding.target.enabled || !binding.target.purposes.includes('preview')) return { version: 1, route: 'unavailable', requirementNo: requirement.requirementNo, serviceKey: linked.serviceKey, reason: 'preview_binding_not_available', retryToFallback: false, cacheTtlSeconds: 5 };
    let targetConfig: Record<string, unknown>;
    try { const parsed: unknown = JSON.parse(this.crypto.decrypt(binding.target.encryptedConfig)); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid target config'); targetConfig = parsed as Record<string, unknown>; }
    catch { return { version: 1, route: 'unavailable', requirementNo: requirement.requirementNo, serviceKey: linked.serviceKey, reason: 'preview_target_config_invalid', retryToFallback: false, cacheTtlSeconds: 5 }; }
    const endpoint = requirement.routeEndpoints[0];
    let expectedPreviewNamespace: string | null = null;
    try { expectedPreviewNamespace = previewNamespaceName(this.config.get('PREVIEW_NAMESPACE_PREFIX', 'codegen-preview'), requirement.teamId); } catch { /* 配置非法时忽略不可信端点并安全回落 */ }
    const endpointValid = endpoint
      && endpoint.targetId === binding.targetId
      && endpoint.previewInstance.targetId === binding.targetId
      && endpoint.previewInstance.requirementId === requirement.id
      && endpoint.previewInstance.serviceKey === linked.serviceKey
      && endpoint.namespace === expectedPreviewNamespace
      && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(endpoint.serviceName)
      && endpoint.serviceName.length <= 63
      && Number.isInteger(endpoint.port) && endpoint.port >= 1 && endpoint.port <= 65535;
    if (endpoint && endpointValid) {
      const remainingLeaseSeconds = Math.max(1, Math.floor((endpoint.leaseExpiresAt.getTime() - Date.now()) / 1_000));
      const configuredCacheSeconds = Number(this.config.get('PREVIEW_ROUTING_CACHE_TTL_SECONDS', 10));
      const cacheLimitSeconds = Number.isInteger(configuredCacheSeconds) && configuredCacheSeconds >= 1 ? Math.min(configuredCacheSeconds, 30) : 10;
      return { version: 1, route: 'preview', requirementNo: requirement.requirementNo, serviceKey: linked.serviceKey, targetId: endpoint.targetId, namespace: endpoint.namespace, serviceName: endpoint.serviceName, port: endpoint.port, endpointUrl: `http://${endpoint.serviceName}.${endpoint.namespace}.svc.cluster.local:${endpoint.port}`, publicUrl: endpoint.publicUrl, retryToFallback: false, cacheTtlSeconds: Math.min(remainingLeaseSeconds, cacheLimitSeconds), leaseExpiresAt: endpoint.leaseExpiresAt };
    }
    const config = (binding.config || {}) as Record<string, unknown>;
    const namespace = typeof config.testNamespace === 'string' ? config.testNamespace : null;
    const serviceName = typeof config.testServiceName === 'string' ? config.testServiceName : linked.serviceKey;
    const configuredPort = Number(config.testServicePort); const port = Number.isInteger(configuredPort) && configuredPort >= 1 && configuredPort <= 65535 ? configuredPort : 80;
    const businessNamespaces = Array.isArray(targetConfig.businessNamespaces) ? targetConfig.businessNamespaces.filter((value): value is string => typeof value === 'string') : [];
    if (!namespace || !businessNamespaces.includes(namespace)) return { version: 1, route: 'unavailable', requirementNo: requirement.requirementNo, serviceKey: linked.serviceKey, reason: namespace ? 'test_fallback_namespace_denied' : 'test_fallback_not_configured', retryToFallback: false, cacheTtlSeconds: 5 };
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(serviceName) || serviceName.length > 63) return { version: 1, route: 'unavailable', requirementNo: requirement.requirementNo, serviceKey: linked.serviceKey, reason: 'test_fallback_service_invalid', retryToFallback: false, cacheTtlSeconds: 5 };
    return { version: 1, route: 'test', requirementNo: requirement.requirementNo, serviceKey: linked.serviceKey, targetId: binding.targetId, namespace, serviceName, port, endpointUrl: `http://${serviceName}.${namespace}.svc.cluster.local:${port}`, retryToFallback: false, cacheTtlSeconds: 15 };
  }

  async removeExpired() {
    const expired = await this.prisma.requirementRouteEndpoint.findMany({ where: { leaseExpiresAt: { lte: new Date() } }, select: { id: true, requirementId: true, serviceKey: true }, take: 500 });
    if (!expired.length) return;
    await this.prisma.$transaction([
      this.prisma.requirementRouteEndpoint.deleteMany({ where: { id: { in: expired.map((item) => item.id) } } }),
      ...expired.map((item) => this.prisma.requirementProject.updateMany({ where: { requirementId: item.requirementId, serviceKey: item.serviceKey, status: 'preview' }, data: { status: 'developing' } })),
      ...expired.map((item) => this.prisma.requirementActivity.create({ data: { requirementId: item.requirementId, action: 'requirement.preview.lease_expired', detail: { serviceKey: item.serviceKey } } })),
    ]);
  }
}
