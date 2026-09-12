import { BadRequestException, Injectable, NotFoundException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { assertSafeKubeconfig } from './kubeconfig-policy';
import { diagnosticMessage } from '../common/redact-diagnostic';

interface K8sTargetConfig {
  kubeconfig: string; // kubeconfig YAML 内容
  businessNamespaces?: string[];
}

export function previewNamespaceName(prefix: string, teamId: string) {
  const clean = (value: string) => value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
  const normalizedPrefix = clean(prefix) || 'codegen-preview';
  const normalizedTeam = clean(teamId);
  const name = `${normalizedPrefix}-${normalizedTeam}`.slice(0, 63).replace(/-+$/g, '');
  if (!normalizedTeam || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name)) {
    throw new BadRequestException({ code: 'K8S_PREVIEW_NAMESPACE_INVALID', message: '无法生成合法的预览 Namespace 名称' });
  }
  return name;
}

function networkPolicy(name: string, namespace: string, labels: Record<string, string>, spec: k8s.V1NetworkPolicySpec): k8s.V1NetworkPolicy {
  return { metadata: { name, namespace, labels }, spec };
}

async function upsertResource<T extends { metadata?: { resourceVersion?: string } }>(
  read: () => Promise<T>,
  create: () => Promise<unknown>,
  replace: (current: T) => Promise<unknown>,
) {
  try {
    const current = await read();
    await replace(current);
  } catch (error) {
    if (httpStatus(error) !== 404) throw error;
    await create();
  }
}

function httpStatus(error: unknown) {
  const value = error as { code?: number; statusCode?: number; response?: { statusCode?: number } };
  return value?.code || value?.statusCode || value?.response?.statusCode;
}

@Injectable()
export class K8sService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
  ) {}

  // 获取用户的 K8s 部署目标
  async getK8sTargets(userId: string, limit?: number) {
    const targets = await this.prisma.deployTarget.findMany({
      where: {
        kind: 'k8s',
        OR: [
          { userId },
          { scope: 'platform' },
          { scope: 'team', team: { members: { some: { id: userId } } } },
        ],
      },
      select: { id: true, name: true, summary: true, createdAt: true },
      ...(limit ? { take: limit } : {}),
    });
    return targets;
  }

  // 获取 K8s 客户端
  async getAuthorizedClients(targetId: string, userId: string) {
    const target = await this.prisma.deployTarget.findFirst({
      where: {
        id: targetId,
        OR: [
          { userId },
          { scope: 'platform' },
          { scope: 'team', team: { members: { some: { id: userId } } } },
        ],
      },
    });

    if (!target) {
      throw new NotFoundException({ code: 'DEPLOY_TARGET_NOT_FOUND_OR_INACCESSIBLE', message: '部署目标不存在或无权访问' });
    }

    if (target.kind !== 'k8s') {
      throw new BadRequestException({ code: 'DEPLOY_TARGET_KIND_MISMATCH', message: '所选部署目标不是 Kubernetes 集群' });
    }

    if (!target.enabled) {
      throw new BadRequestException({ code: 'DEPLOY_TARGET_DISABLED', message: '所选部署目标已停用' });
    }

    const config = JSON.parse(
      this.crypto.decrypt(target.encryptedConfig),
    ) as K8sTargetConfig;

    assertSafeKubeconfig(config.kubeconfig);
    const kc = new k8s.KubeConfig();
    kc.loadFromString(config.kubeconfig);

    // 本地 API Server 不应经过代理；保留运维侧已经配置的其它 NO_PROXY 条目。
    const cluster = kc.getCurrentCluster();
    if (cluster?.server && (cluster.server.includes('localhost') || cluster.server.includes('127.0.0.1'))) {
      const entries = new Set((process.env.NO_PROXY || '').split(',').map((item) => item.trim()).filter(Boolean));
      entries.add('localhost');
      entries.add('127.0.0.1');
      process.env.NO_PROXY = [...entries].join(',');
    }

    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    const networkingApi = kc.makeApiClient(k8s.NetworkingV1Api);
    const batchApi = kc.makeApiClient(k8s.BatchV1Api);

    return { kc, coreApi, appsApi, networkingApi, batchApi, target, config };
  }

  /** 幂等初始化团队级预览 Namespace 及其安全、资源治理基线。 */
  async provisionPreviewNamespace(targetId: string, userId: string, teamId: string) {
    const team = await this.prisma.team.findFirst({
      where: { id: teamId, members: { some: { id: userId } } },
      select: { id: true, name: true },
    });
    if (!team) throw new ForbiddenException({ code: 'K8S_TEAM_ACCESS_DENIED', message: '不属于该项目组' });
    const { coreApi, networkingApi, target } = await this.getAuthorizedClients(targetId, userId);
    if (!target.purposes.includes('preview')) {
      throw new BadRequestException({ code: 'K8S_PREVIEW_PURPOSE_DISABLED', message: '该 Kubernetes 目标未启用预览用途' });
    }
    if (target.scope === 'team' && target.teamId !== teamId) {
      throw new ForbiddenException({ code: 'K8S_TARGET_TEAM_MISMATCH', message: '运行资源与项目组不匹配' });
    }

    const namespace = previewNamespaceName(this.config.get('PREVIEW_NAMESPACE_PREFIX', 'codegen-preview'), teamId);
    const labels = {
      'app.kubernetes.io/managed-by': 'codegen-platform',
      'codegen.io/environment': 'preview',
      'codegen.io/team-id': teamId,
      'pod-security.kubernetes.io/enforce': 'restricted',
      'pod-security.kubernetes.io/audit': 'restricted',
      'pod-security.kubernetes.io/warn': 'restricted',
    };
    await upsertResource(
      () => coreApi.readNamespace({ name: namespace }),
      () => coreApi.createNamespace({ body: { metadata: { name: namespace, labels } } }),
      (current) => coreApi.replaceNamespace({ name: namespace, body: { ...current, metadata: { ...current.metadata, name: namespace, labels: { ...current.metadata?.labels, ...labels } } } }),
    );

    const serviceAccount = 'codegen-preview';
    await upsertResource(
      () => coreApi.readNamespacedServiceAccount({ name: serviceAccount, namespace }),
      () => coreApi.createNamespacedServiceAccount({ namespace, body: { metadata: { name: serviceAccount, namespace, labels }, automountServiceAccountToken: false } }),
      (current) => coreApi.replaceNamespacedServiceAccount({ name: serviceAccount, namespace, body: { metadata: { name: serviceAccount, namespace, labels, resourceVersion: current.metadata?.resourceVersion }, automountServiceAccountToken: false } }),
    );

    const quotaName = 'codegen-preview-quota';
    const hard = {
      pods: this.config.get('PREVIEW_NAMESPACE_MAX_PODS', '50'),
      'requests.cpu': this.config.get('PREVIEW_NAMESPACE_REQUESTS_CPU', '16'),
      'requests.memory': this.config.get('PREVIEW_NAMESPACE_REQUESTS_MEMORY', '32Gi'),
      'limits.cpu': this.config.get('PREVIEW_NAMESPACE_LIMITS_CPU', '32'),
      'limits.memory': this.config.get('PREVIEW_NAMESPACE_LIMITS_MEMORY', '64Gi'),
      persistentvolumeclaims: this.config.get('PREVIEW_NAMESPACE_MAX_PVCS', '10'),
      'requests.storage': this.config.get('PREVIEW_NAMESPACE_STORAGE', '200Gi'),
    };
    await upsertResource(
      () => coreApi.readNamespacedResourceQuota({ name: quotaName, namespace }),
      () => coreApi.createNamespacedResourceQuota({ namespace, body: { metadata: { name: quotaName, namespace, labels }, spec: { hard } } }),
      (current) => coreApi.replaceNamespacedResourceQuota({ name: quotaName, namespace, body: { metadata: { name: quotaName, namespace, labels, resourceVersion: current.metadata?.resourceVersion }, spec: { hard } } }),
    );

    const limitName = 'codegen-preview-limits';
    const limits = [{ type: 'Container', defaultRequest: { cpu: '100m', memory: '128Mi' }, default: { cpu: '1', memory: '1Gi' }, max: { cpu: '2', memory: '4Gi' } }];
    await upsertResource(
      () => coreApi.readNamespacedLimitRange({ name: limitName, namespace }),
      () => coreApi.createNamespacedLimitRange({ namespace, body: { metadata: { name: limitName, namespace, labels }, spec: { limits } } }),
      (current) => coreApi.replaceNamespacedLimitRange({ name: limitName, namespace, body: { metadata: { name: limitName, namespace, labels, resourceVersion: current.metadata?.resourceVersion }, spec: { limits } } }),
    );

    const denyPolicy = networkPolicy('codegen-preview-default-deny', namespace, labels, { podSelector: {}, policyTypes: ['Ingress', 'Egress'] });
    await this.upsertNetworkPolicy(networkingApi, namespace, denyPolicy);
    const dnsPolicy = networkPolicy('codegen-preview-dns', namespace, labels, {
      podSelector: {}, policyTypes: ['Egress'],
      egress: [{
        to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } }, podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } } }],
        ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }],
      }],
    });
    await this.upsertNetworkPolicy(networkingApi, namespace, dnsPolicy);

    return { namespace, team, target: { id: target.id, name: target.name }, serviceAccount, managed: true };
  }

  private async upsertNetworkPolicy(api: k8s.NetworkingV1Api, namespace: string, policy: k8s.V1NetworkPolicy) {
    const name = policy.metadata!.name!;
    await upsertResource(
      () => api.readNamespacedNetworkPolicy({ name, namespace }),
      () => api.createNamespacedNetworkPolicy({ namespace, body: policy }),
      (current) => api.replaceNamespacedNetworkPolicy({ name, namespace, body: { ...policy, metadata: { ...policy.metadata, resourceVersion: current.metadata?.resourceVersion } } }),
    );
  }

  // 列出 Namespaces
  async listNamespaces(targetId: string, userId: string, limit?: number) {
    const { coreApi } = await this.getAuthorizedClients(targetId, userId);
    const res = await coreApi.listNamespace(limit ? { limit } : {});

    return res.items.map((ns) => ({
      name: ns.metadata?.name,
      status: ns.status?.phase,
      createdAt: ns.metadata?.creationTimestamp,
      labels: ns.metadata?.labels,
    }));
  }

  // 创建 Namespace
  async createNamespace(targetId: string, userId: string, name: string) {
    const { coreApi } = await this.getAuthorizedClients(targetId, userId);

    const namespace: k8s.V1Namespace = {
      metadata: { name },
    };

    const res = await coreApi.createNamespace({ body: namespace });
    return { name: res.metadata?.name };
  }

  // 删除 Namespace
  async deleteNamespace(targetId: string, userId: string, name: string) {
    const { coreApi } = await this.getAuthorizedClients(targetId, userId);
    await coreApi.deleteNamespace({ name });
    return { deleted: true };
  }

  // 列出 Pods
  async listPods(targetId: string, userId: string, namespace: string, limit?: number) {
    const { coreApi } = await this.getAuthorizedClients(targetId, userId);
    const res = await coreApi.listNamespacedPod({ namespace, ...(limit ? { limit } : {}) });

    return res.items.map((pod) => ({
      name: pod.metadata?.name,
      namespace: pod.metadata?.namespace,
      status: pod.status?.phase,
      ready: this.getPodReadyStatus(pod),
      restarts: this.getPodRestarts(pod),
      age: pod.metadata?.creationTimestamp,
      ip: pod.status?.podIP,
      node: pod.spec?.nodeName,
    }));
  }

  /** 直接读取 API Server，返回集群全部 Namespace 下的 Pod；不使用数据库运行状态。 */
  async clusterOverview(targetId: string, userId: string) {
    try {
      const { coreApi, appsApi, target } = await this.getAuthorizedClients(targetId, userId);
      const [pods, namespaces, deployments] = await Promise.all([
        coreApi.listPodForAllNamespaces(),
        coreApi.listNamespace(),
        appsApi.listDeploymentForAllNamespaces(),
      ]);
      return {
        reachable: true,
        observedAt: new Date().toISOString(),
        target: { id: target.id, name: target.name },
        namespaces: namespaces.items.map((item) => item.metadata?.name).filter(Boolean),
        deployments: deployments.items.map((deployment) => ({
          name: deployment.metadata?.name,
          namespace: deployment.metadata?.namespace,
          desired: deployment.spec?.replicas || 0,
          current: deployment.status?.replicas || 0,
          ready: deployment.status?.readyReplicas || 0,
          available: deployment.status?.availableReplicas || 0,
          updated: deployment.status?.updatedReplicas || 0,
          images: deployment.spec?.template.spec?.containers.map((container) => container.image) || [],
          strategy: deployment.spec?.strategy?.type || 'RollingUpdate',
          createdAt: deployment.metadata?.creationTimestamp || null,
          conditions: (deployment.status?.conditions || []).map((condition) => ({
            type: condition.type,
            status: condition.status,
            reason: condition.reason || null,
            message: condition.message || null,
            updatedAt: condition.lastUpdateTime || condition.lastTransitionTime || null,
          })),
        })),
        pods: pods.items.map((pod) => ({
          name: pod.metadata?.name,
          namespace: pod.metadata?.namespace,
          phase: pod.status?.phase || 'Unknown',
          ready: this.getPodReadyStatus(pod),
          restarts: this.getPodRestarts(pod),
          node: pod.spec?.nodeName || null,
          podIP: pod.status?.podIP || null,
          hostIP: pod.status?.hostIP || null,
          images: pod.spec?.containers.map((container) => container.image),
          workloadKind: pod.metadata?.ownerReferences?.[0]?.kind || null,
          workloadName: pod.metadata?.ownerReferences?.[0]?.name || null,
          createdAt: pod.metadata?.creationTimestamp || null,
        })),
      };
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException || error instanceof ForbiddenException) throw error;
      throw new ServiceUnavailableException({
        code: 'K8S_CLUSTER_UNREACHABLE',
        message: `集群不可达/无法连接：${diagnosticMessage(error)}`,
      });
    }
  }

  // 获取 Pod 详情
  async getPod(targetId: string, userId: string, namespace: string, name: string) {
    const { coreApi } = await this.getAuthorizedClients(targetId, userId);
    const [pod, eventList] = await Promise.all([
      coreApi.readNamespacedPod({ name, namespace }),
      coreApi.listNamespacedEvent({ namespace, fieldSelector: `involvedObject.kind=Pod,involvedObject.name=${name}` }),
    ]);
    const statuses = new Map((pod.status?.containerStatuses || []).map((status) => [status.name, status]));

    return {
      name: pod.metadata?.name,
      namespace: pod.metadata?.namespace,
      status: pod.status?.phase,
      ready: this.getPodReadyStatus(pod),
      restarts: this.getPodRestarts(pod),
      age: pod.metadata?.creationTimestamp,
      ip: pod.status?.podIP,
      node: pod.spec?.nodeName,
      labels: pod.metadata?.labels,
      containers: pod.spec?.containers.map((c) => ({
        name: c.name,
        image: c.image,
        ports: c.ports?.map((p) => p.containerPort),
        ready: statuses.get(c.name)?.ready || false,
        restartCount: statuses.get(c.name)?.restartCount || 0,
        state: this.containerState(statuses.get(c.name)?.state),
        lastState: this.containerState(statuses.get(c.name)?.lastState),
      })),
      conditions: pod.status?.conditions,
      events: eventList.items
        .sort((left, right) => String(right.lastTimestamp || right.eventTime || '').localeCompare(String(left.lastTimestamp || left.eventTime || '')))
        .slice(0, 50)
        .map((event) => ({
          type: event.type || 'Normal',
          reason: event.reason || null,
          message: event.message || null,
          count: event.count || 1,
          firstAt: event.firstTimestamp || null,
          lastAt: event.lastTimestamp || event.eventTime || null,
          source: event.source?.component || null,
        })),
    };
  }

  // 获取 Pod 日志
  async getPodLogs(
    targetId: string,
    userId: string,
    namespace: string,
    name: string,
    tailLines: number = 200,
    container?: string,
    previous = false,
  ) {
    const { coreApi } = await this.getAuthorizedClients(targetId, userId);

    try {
      const res = await coreApi.readNamespacedPodLog({
        name,
        namespace,
        container: container || undefined,
        follow: false,
        previous,
        tailLines: Math.max(1, Math.min(5000, tailLines || 200)),
      });

      return { logs: typeof res === 'string' ? res : String(res ?? '') };
    } catch (error) {
      return { logs: '无法获取日志', error: String(error) };
    }
  }

  // 删除 Pod
  async deletePod(targetId: string, userId: string, namespace: string, name: string) {
    const { coreApi } = await this.getAuthorizedClients(targetId, userId);
    await coreApi.deleteNamespacedPod({ name, namespace });
    return { deleted: true };
  }

  // 列出 Deployments
  async listDeployments(targetId: string, userId: string, namespace: string, limit?: number) {
    const { appsApi } = await this.getAuthorizedClients(targetId, userId);
    const res = await appsApi.listNamespacedDeployment({ namespace, ...(limit ? { limit } : {}) });

    return res.items.map((dep) => ({
      name: dep.metadata?.name,
      namespace: dep.metadata?.namespace,
      replicas: dep.spec?.replicas,
      ready: `${dep.status?.readyReplicas || 0}/${dep.spec?.replicas || 0}`,
      upToDate: dep.status?.updatedReplicas,
      available: dep.status?.availableReplicas,
      age: dep.metadata?.creationTimestamp,
    }));
  }

  // 扩缩容 Deployment
  async scaleDeployment(
    targetId: string,
    userId: string,
    namespace: string,
    name: string,
    replicas: number,
  ) {
    const { appsApi } = await this.getAuthorizedClients(targetId, userId);

    const patch = [
      {
        op: 'replace',
        path: '/spec/replicas',
        value: replicas,
      },
    ];

    await appsApi.patchNamespacedDeployment(
      { name, namespace, body: patch },
      k8s.setHeaderOptions('Content-Type', 'application/json-patch+json'),
    );

    return { replicas };
  }

  // 重启 Deployment（通过更新 annotation 触发滚动重启）
  async restartDeployment(targetId: string, userId: string, namespace: string, name: string) {
    const { appsApi } = await this.getAuthorizedClients(targetId, userId);

    const patch = [
      {
        op: 'add',
        path: '/spec/template/metadata/annotations/restartedAt',
        value: new Date().toISOString(),
      },
    ];

    await appsApi.patchNamespacedDeployment(
      { name, namespace, body: patch },
      k8s.setHeaderOptions('Content-Type', 'application/json-patch+json'),
    );

    return { restarted: true };
  }

  async deleteDeployment(targetId: string, userId: string, namespace: string, name: string) {
    const { appsApi } = await this.getAuthorizedClients(targetId, userId);
    await appsApi.deleteNamespacedDeployment({ name, namespace, propagationPolicy: 'Foreground' });
    return { deleted: true };
  }

  // 列出 Services
  async listServices(targetId: string, userId: string, namespace: string, limit?: number) {
    const { coreApi } = await this.getAuthorizedClients(targetId, userId);
    const res = await coreApi.listNamespacedService({ namespace, ...(limit ? { limit } : {}) });

    return res.items.map((svc) => ({
      name: svc.metadata?.name,
      namespace: svc.metadata?.namespace,
      type: svc.spec?.type,
      clusterIP: svc.spec?.clusterIP,
      externalIPs: svc.spec?.externalIPs,
      ports: svc.spec?.ports?.map((p) => `${p.port}:${p.targetPort}/${p.protocol}`),
      age: svc.metadata?.creationTimestamp,
    }));
  }

  // 辅助方法：获取 Pod 就绪状态
  private getPodReadyStatus(pod: k8s.V1Pod): string {
    const total = pod.status?.containerStatuses?.length || 0;
    const ready = pod.status?.containerStatuses?.filter((c) => c.ready).length || 0;
    return `${ready}/${total}`;
  }

  // 辅助方法：获取 Pod 重启次数
  private getPodRestarts(pod: k8s.V1Pod): number {
    return (
      pod.status?.containerStatuses?.reduce((sum, c) => sum + c.restartCount, 0) || 0
    );
  }

  private containerState(state?: k8s.V1ContainerState) {
    if (state?.running) return { type: 'running', startedAt: state.running.startedAt || null };
    if (state?.waiting) return { type: 'waiting', reason: state.waiting.reason || null, message: state.waiting.message || null };
    if (state?.terminated) return { type: 'terminated', reason: state.terminated.reason || null, message: state.terminated.message || null, exitCode: state.terminated.exitCode, startedAt: state.terminated.startedAt || null, finishedAt: state.terminated.finishedAt || null };
    return { type: 'unknown' };
  }
}
