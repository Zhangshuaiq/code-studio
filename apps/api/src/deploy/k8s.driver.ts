// k8s 部署驱动：经 kube-apiserver（@kubernetes/client-node，out-of-cluster kubeconfig）
// 下发 Deployment + Service(NodePort)。与 docker 驱动不同——不在目标上 build/run，
// 而是「本地构建镜像 → 集群按 tag 拉起 Pod」。本机 Docker Desktop k8s 共享本地镜像库，
// 故 imagePullPolicy=IfNotPresent 即可免 registry；真实远程集群需把镜像推到集群可拉取的仓库。
import * as k8s from '@kubernetes/client-node';

export interface K8sApplyInput {
  namespace: string;
  name: string;
  image: string;
  containerPort: number;
  baseDomain?: string; // URL 主机名，默认 localhost（Docker Desktop 把 NodePort 映射到 localhost）
  env?: Record<string, string>;
  imagePullSecrets?: string[]; // 私有 registry 拉取凭证（dockerconfigjson Secret 名）
  secretEnvName?: string;
}

export type K8sPhase = 'building' | 'running' | 'failed';
export interface K8sStatus {
  phase: K8sPhase;
  message?: string;
  logs?: string;
  events?: string;
}

const BAD_WAITING =
  /ImagePullBackOff|ErrImageNeverPull|ImagePullErr|ImageInspectError|InvalidImageName|CrashLoopBackOff|RunContainerError|CreateContainerError/;

export class K8sDriver {
  private readonly core: k8s.CoreV1Api;
  private readonly apps: k8s.AppsV1Api;

  constructor(kubeconfig: string) {
    const kc = new k8s.KubeConfig();
    kc.loadFromString(kubeconfig);
    this.core = kc.makeApiClient(k8s.CoreV1Api);
    this.apps = kc.makeApiClient(k8s.AppsV1Api);
  }

  /** 下发/更新 Deployment + Service(NodePort)，返回 nodePort 与访问 URL */
  async apply(input: K8sApplyInput): Promise<{ nodePort: number; url: string }> {
    const { namespace, name, image, containerPort, env } = input;
    const labels = { app: name, 'managed-by': 'codegen' };

    const deployment: k8s.V1Deployment = {
      metadata: { name, namespace, labels },
      spec: {
        replicas: 1,
        minReadySeconds: 3,
        progressDeadlineSeconds: 180,
        revisionHistoryLimit: 5,
        strategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } },
        selector: { matchLabels: { app: name } },
        template: {
          metadata: { labels },
          spec: {
            imagePullSecrets: input.imagePullSecrets?.length
              ? input.imagePullSecrets.map((n) => ({ name: n }))
              : undefined,
            containers: [
              {
                name: 'app',
                image,
                imagePullPolicy: 'IfNotPresent',
                ports: [{ containerPort }],
                env: Object.entries(env ?? {}).map(([k, v]) => ({
                  name: k,
                  value: String(v),
                })),
                envFrom: input.secretEnvName ? [{ secretRef: { name: input.secretEnvName } }] : undefined,
                resources: {
                  requests: { memory: '64Mi', cpu: '50m' },
                  limits: { memory: '512Mi', cpu: '1' },
                },
                startupProbe: { tcpSocket: { port: containerPort }, periodSeconds: 3, failureThreshold: 30, timeoutSeconds: 2 },
                readinessProbe: { tcpSocket: { port: containerPort }, periodSeconds: 5, failureThreshold: 3, timeoutSeconds: 2 },
                livenessProbe: { tcpSocket: { port: containerPort }, periodSeconds: 10, failureThreshold: 3, timeoutSeconds: 2 },
              },
            ],
          },
        },
      },
    };

    // Deployment：存在则带 resourceVersion 替换（滚动更新到新镜像），否则创建
    const existing = await this.apps
      .readNamespacedDeployment({ name, namespace })
      .catch((e) => {
        if (is404(e)) return null;
        throw e;
      });
    if (existing) {
      deployment.metadata!.resourceVersion = existing.metadata?.resourceVersion;
      await this.apps.replaceNamespacedDeployment({ name, namespace, body: deployment });
    } else {
      await this.apps.createNamespacedDeployment({ namespace, body: deployment });
    }

    // Service：缺则建（NodePort），已存在就复用——保持 nodePort 稳定（URL 跨重部署不变）
    let nodePort = await this.core
      .readNamespacedService({ name, namespace })
      .then((r) => r.spec?.ports?.[0]?.nodePort)
      .catch((e) => {
        if (is404(e)) return undefined;
        throw e;
      });
    if (nodePort == null) {
      const service: k8s.V1Service = {
        metadata: { name, namespace, labels },
        spec: {
          type: 'NodePort',
          selector: { app: name },
          ports: [
            {
              port: containerPort,
              targetPort: containerPort,
              protocol: 'TCP',
            },
          ],
        },
      };
      const created = await this.core.createNamespacedService({
        namespace,
        body: service,
      });
      nodePort = created.spec?.ports?.[0]?.nodePort;
    }
    if (nodePort == null) throw new Error('未能分配 NodePort');

    const host = input.baseDomain || 'localhost';
    return { nodePort, url: `http://${host}:${nodePort}` };
  }

  /** 查部署状态：可用副本≥1 为 running；镜像拉取失败/崩溃循环为 failed（带 Pod 日志） */
  async status(namespace: string, name: string): Promise<K8sStatus> {
    const dep = await this.apps
      .readNamespacedDeployment({ name, namespace })
      .catch((error) => {
        if (is404(error)) return null;
        throw error;
      });
    if (!dep) return { phase: 'failed', message: 'Deployment 不存在' };

    const pods = await this.core
      .listNamespacedPod({ namespace, labelSelector: `app=${name}` })
      .then((r) => r.items);
    const events = await this.events(namespace, name, pods.map((pod) => pod.metadata?.name).filter(Boolean) as string[]);
    const deadlineExceeded = dep.status?.conditions?.find((condition) => condition.type === 'Progressing' && condition.status === 'False' && condition.reason === 'ProgressDeadlineExceeded');
    if (deadlineExceeded) return { phase: 'failed', message: deadlineExceeded.message || 'Deployment 就绪超时', events };

    for (const p of pods) {
      const cs = p.status?.containerStatuses?.[0];
      const waiting = cs?.state?.waiting?.reason;
      const podName = p.metadata?.name;
      if (waiting && BAD_WAITING.test(waiting)) {
        const logs = podName ? await this.podLogs(namespace, podName) : '';
        const detail = cs?.state?.waiting?.message
          ? `：${cs.state.waiting.message}`
          : '';
        return { phase: 'failed', message: `Pod ${waiting}${detail}`, logs, events };
      }
      if ((cs?.restartCount ?? 0) > 0 && cs?.state?.waiting) {
        const logs = podName ? await this.podLogs(namespace, podName) : '';
        return {
          phase: 'failed',
          message: `容器崩溃重启 ${cs?.restartCount} 次`,
          logs,
          events,
        };
      }
    }

    if ((dep.status?.availableReplicas ?? 0) >= 1) {
      const podName = pods[0]?.metadata?.name;
      const logs = podName ? await this.podLogs(namespace, podName) : '';
      return { phase: 'running', logs, events };
    }
    return { phase: 'building', events };
  }

  /** 幂等创建/更新私有 registry 拉取密钥（type=dockerconfigjson），返回 Secret 名 */
  async ensureImagePullSecret(
    namespace: string,
    name: string,
    reg: { url: string; username: string; password: string },
  ): Promise<string> {
    const auth = Buffer.from(`${reg.username}:${reg.password}`).toString(
      'base64',
    );
    const dockercfg = {
      auths: {
        [reg.url]: {
          username: reg.username,
          password: reg.password,
          auth,
        },
      },
    };
    const secret: k8s.V1Secret = {
      metadata: { name, namespace },
      type: 'kubernetes.io/dockerconfigjson',
      data: {
        '.dockerconfigjson': Buffer.from(JSON.stringify(dockercfg)).toString(
          'base64',
        ),
      },
    };
    const existing = await this.core
      .readNamespacedSecret({ name, namespace })
      .catch((e) => {
        if (is404(e)) return null;
        throw e;
      });
    if (existing) {
      secret.metadata!.resourceVersion = existing.metadata?.resourceVersion;
      await this.core.replaceNamespacedSecret({ name, namespace, body: secret });
    } else {
      await this.core.createNamespacedSecret({ namespace, body: secret });
    }
    return name;
  }

  async ensureOpaqueSecret(namespace: string, name: string, values: Record<string, string>): Promise<string> {
    const secret: k8s.V1Secret = { metadata: { name, namespace, labels: { 'managed-by': 'codegen' } }, type: 'Opaque', stringData: values };
    const existing = await this.core.readNamespacedSecret({ name, namespace }).catch((error) => is404(error) ? null : Promise.reject(error));
    if (existing) {
      secret.metadata!.resourceVersion = existing.metadata?.resourceVersion;
      await this.core.replaceNamespacedSecret({ name, namespace, body: secret });
    } else await this.core.createNamespacedSecret({ namespace, body: secret });
    return name;
  }

  /** 删除 Deployment + Service + 拉取密钥（幂等） */
  async remove(namespace: string, name: string): Promise<void> {
    await this.apps
      .deleteNamespacedDeployment({ name, namespace })
      .catch((error) => is404(error) ? undefined : Promise.reject(error));
    await this.core
      .deleteNamespacedService({ name, namespace })
      .catch((error) => is404(error) ? undefined : Promise.reject(error));
    await this.core
      .deleteNamespacedSecret({ name: `${name}-pull`, namespace })
      .catch((error) => is404(error) ? undefined : Promise.reject(error));
    await this.core.deleteNamespacedSecret({ name: `${name}-database`, namespace }).catch((error) => is404(error) ? undefined : Promise.reject(error));
  }

  private async podLogs(namespace: string, pod: string): Promise<string> {
    try {
      const r = await this.core.readNamespacedPodLog({
        name: pod,
        namespace,
        follow: false,
        previous: false,
        tailLines: 200,
      });
      return typeof r === 'string' ? r : String(r ?? '');
    } catch {
      return '';
    }
  }

  private async events(namespace: string, deployment: string, pods: string[]): Promise<string> {
    try {
      const response = await this.core.listNamespacedEvent({ namespace });
      const names = new Set([deployment, ...pods]);
      return response.items
        .filter((event) => names.has(event.involvedObject?.name || ''))
        .sort((a, b) => String(a.lastTimestamp || a.eventTime || '').localeCompare(String(b.lastTimestamp || b.eventTime || '')))
        .slice(-50)
        .map((event) => `${event.type || 'Normal'} ${event.reason || 'Event'}: ${event.message || ''}`)
        .join('\n');
    } catch {
      return '';
    }
  }
}

function is404(e: unknown): boolean {
  const any = e as {
    code?: number;
    statusCode?: number;
    response?: { status?: number; statusCode?: number; body?: unknown };
    body?: { code?: number } | string;
  };
  let bodyCode: number | undefined;
  if (typeof any?.body === 'string') {
    try { bodyCode = Number(JSON.parse(any.body)?.code); } catch { bodyCode = undefined; }
  } else bodyCode = any?.body?.code;
  return (
    any?.code === 404 ||
    any?.statusCode === 404 ||
    any?.response?.status === 404 ||
    any?.response?.statusCode === 404 ||
    bodyCode === 404
  );
}
