import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as k8s from '@kubernetes/client-node';
import { relative, resolve, sep } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { ExecResult, SandboxService } from '../sandbox/sandbox.service';
import { configuredRuntime, getRuntime, isImmutableImageReference, ProjectRuntime, runtimeDependencyEnv } from '../sandbox/language-runtime';
import { dependencyPolicyRequiresProxy, resolveDependencyAccessPolicy } from '../common/dependency-access-policy';
import { WorkspaceService } from '../workspace/workspace.service';

export interface GenerationWorkspace {
  volumePath: string;
  runtime: ProjectRuntime;
}

export interface GenerationExecResult extends ExecResult {
  executorKind: 'docker' | 'kubernetes';
  executionRef?: string;
  executionNamespace?: string;
  failureCode?: GenerationFailureCode;
}

export type GenerationFailureCode =
  | 'command_failed'
  | 'image_pull'
  | 'oom_killed'
  | 'disk_limit'
  | 'evicted'
  | 'deadline_exceeded'
  | 'job_failed'
  | 'cluster_error';

/**
 * 代码生成专用执行器。
 *
 * provider 仍在 Worker 中编辑共享工作区；构建门禁可选择在 Docker 容器或
 * Kubernetes Job 中执行。Kubernetes 模式不接触 Docker Socket，并通过 RWX
 * PVC 的 subPath 只挂载当前会话工作区。
 */
@Injectable()
export class GenerationExecutorService {
  private readonly logger = new Logger(GenerationExecutorService.name);
  private readonly mode: 'docker' | 'kubernetes';
  private batchApi?: k8s.BatchV1Api;
  private coreApi?: k8s.CoreV1Api;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly workspaces: WorkspaceService,
    private readonly sandbox: SandboxService,
  ) {
    this.mode = this.config.get('GENERATION_EXECUTOR', 'kubernetes');
  }

  async prepare(sessionId: string): Promise<GenerationWorkspace> {
    if (this.mode === 'docker') {
      const handle = await this.sandbox.ensureSandbox(sessionId);
      return { volumePath: handle.volumePath, runtime: handle.runtime };
    }

    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: { project: true },
    });
    if (!session) throw new BadRequestException('会话不存在');
    const workspace = await this.workspaces.ensureForSession(
      session.userId,
      sessionId,
    );
    const declared = getRuntime(session.project.language);
    const runtime = configuredRuntime(declared, (key) =>
      this.config.get<string>(key),
    );
    this.workspaceSubPath(workspace.path);
    this.clients();
    return { volumePath: workspace.path, runtime };
  }

  async health() {
    if (this.mode === 'docker') {
      return { ...(await this.sandbox.health()), kind: 'docker' };
    }
    const startedAt = Date.now();
    const namespace = this.config.get('K8S_GENERATION_NAMESPACE', 'default');
    try {
      const { batchApi } = this.clients();
      await batchApi.listNamespacedJob({ namespace, limit: 1 });
      return {
        available: true,
        kind: 'kubernetes',
        namespace,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        available: false,
        kind: 'kubernetes',
        namespace,
        latencyMs: Date.now() - startedAt,
        error: (error as Error).message,
      };
    }
  }

  async exec(
    sessionId: string,
    cmd: string[],
    signal?: AbortSignal,
    options: { taskId?: string; onOutput?: (chunk: string) => void } = {},
  ): Promise<GenerationExecResult> {
    if (this.mode === 'docker') {
      const result = await this.sandbox.exec(sessionId, cmd, signal);
      return {
        ...result,
        executorKind: 'docker',
        ...(result.exitCode !== 0 ? { failureCode: 'command_failed' as const } : {}),
      };
    }
    signal?.throwIfAborted();
    const handle = await this.prepare(sessionId);
    if (
      this.config.get<string>('K8S_GENERATION_REQUIRE_IMAGE_DIGEST', 'true') !== 'false' &&
      !isImmutableImageReference(handle.runtime.dockerImage)
    ) {
      throw new BadRequestException('Kubernetes 生成运行时镜像必须固定到 sha256 digest');
    }
    const namespace = this.config.get('K8S_GENERATION_NAMESPACE', 'default');
    const claimName = this.config.get<string>('K8S_GENERATION_WORKSPACE_CLAIM');
    if (!claimName) {
      throw new BadRequestException(
        'Kubernetes 生成执行器缺少 K8S_GENERATION_WORKSPACE_CLAIM',
      );
    }
    const name = `codegen-verify-${safeName(sessionId)}-${Date.now().toString(36)}`;
    const timeoutSeconds = Number(
      this.config.get('K8S_GENERATION_JOB_TIMEOUT_SECONDS', 1800),
    );
    const { batchApi, coreApi } = this.clients();
    const controllerInstance = safeLabel(
      this.config.get('K8S_GENERATION_CONTROLLER_INSTANCE', 'codegen'),
    );
    const mavenMirrorUrl = this.config
      .get<string>('DEPENDENCY_MAVEN_MIRROR_URL', '')
      .trim();
    const dependencyAccessPolicy = resolveDependencyAccessPolicy(
      this.config.get<string>('DEPENDENCY_ACCESS_POLICY'),
      this.config.get<string>('K8S_GENERATION_REQUIRE_DEPENDENCY_PROXY'),
    );
    if (dependencyPolicyRequiresProxy(dependencyAccessPolicy)) {
      const requiredProxy =
        handle.runtime.id === 'java'
          ? mavenMirrorUrl
          : handle.runtime.id === 'python'
            ? this.config.get<string>('DEPENDENCY_PIP_INDEX_URL', '').trim()
            : this.config.get<string>('DEPENDENCY_NPM_REGISTRY', '').trim();
      if (!requiredProxy) {
        throw new BadRequestException(
          `运行时 ${handle.runtime.id} 在 ${dependencyAccessPolicy} 策略下缺少受控依赖代理配置`,
        );
      }
    }
    const dependencyEnv = runtimeDependencyEnv(
      handle.runtime,
      this.config.get<string>('DEPENDENCY_NPM_REGISTRY'),
      this.config.get<string>('DEPENDENCY_PIP_INDEX_URL'),
      mavenMirrorUrl,
      dependencyAccessPolicy,
    );
    const verifierEnv = {
      ...dependencyEnv,
      HOME: '/tmp/codegen',
    };
    const job: k8s.V1Job = {
      metadata: {
        name,
        namespace,
        labels: {
          'app.kubernetes.io/name': 'codegen-generation',
          'app.kubernetes.io/instance': controllerInstance,
          'codegen.io/session': safeName(sessionId),
        },
      },
      spec: {
        backoffLimit: 0,
        activeDeadlineSeconds: timeoutSeconds,
        ttlSecondsAfterFinished: Number(
          this.config.get('K8S_GENERATION_JOB_TTL_SECONDS', 300),
        ),
        template: {
          metadata: {
            labels: {
              'job-name': name,
              'app.kubernetes.io/name': 'codegen-generation',
              'app.kubernetes.io/instance': controllerInstance,
            },
          },
          spec: {
            restartPolicy: 'Never',
            enableServiceLinks: false,
            terminationGracePeriodSeconds: 10,
            automountServiceAccountToken: false,
            serviceAccountName: this.config.get(
              'K8S_GENERATION_JOB_SERVICE_ACCOUNT',
              'default',
            ),
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 1000,
              runAsGroup: 1000,
              fsGroup: 1000,
              seccompProfile: { type: 'RuntimeDefault' },
            },
            imagePullSecrets: parseCsv(
              this.config.get('K8S_GENERATION_IMAGE_PULL_SECRETS', ''),
            ).map((secret) => ({ name: secret })),
            nodeSelector: parseJsonRecord(
              this.config.get('K8S_GENERATION_NODE_SELECTOR', '{}'),
              'K8S_GENERATION_NODE_SELECTOR',
            ),
            tolerations: parseJsonArray<k8s.V1Toleration>(
              this.config.get('K8S_GENERATION_TOLERATIONS', '[]'),
              'K8S_GENERATION_TOLERATIONS',
            ),
            containers: [
              {
                name: 'verify',
                image: handle.runtime.dockerImage,
                imagePullPolicy: 'IfNotPresent',
                command: cmd,
                workingDir: '/workspace',
                env: Object.entries(verifierEnv).map(([name, value]) => ({
                  name,
                  value,
                })),
                resources: {
                  requests: {
                    cpu: this.config.get('K8S_GENERATION_CPU_REQUEST', '250m'),
                    memory: this.config.get('K8S_GENERATION_MEMORY_REQUEST', '512Mi'),
                    'ephemeral-storage': this.config.get('K8S_GENERATION_EPHEMERAL_REQUEST', '512Mi'),
                  },
                  limits: {
                    cpu: this.config.get('K8S_GENERATION_CPU_LIMIT', '2'),
                    memory: this.config.get('K8S_GENERATION_MEMORY_LIMIT', '2Gi'),
                    'ephemeral-storage': this.config.get('K8S_GENERATION_EPHEMERAL_LIMIT', '2Gi'),
                  },
                },
                securityContext: {
                  allowPrivilegeEscalation: false,
                  capabilities: { drop: ['ALL'] },
                  readOnlyRootFilesystem: true,
                },
                volumeMounts: [
                  {
                    name: 'workspace',
                    mountPath: '/workspace',
                  },
                  {
                    name: 'tmp',
                    mountPath: '/tmp',
                  },
                ],
              },
            ],
            initContainers: [
              {
                name: 'copy-source',
                image: handle.runtime.dockerImage,
                imagePullPolicy: 'IfNotPresent',
                command: [
                  'sh',
                  '-c',
                  "tar -C /source --exclude='./.git' --exclude='./node_modules' --exclude='./dist' --exclude='./build' --exclude='./target' --exclude='./.vite' --exclude='./.venv' --exclude='./venv' --exclude='./__pycache__' -cf - . | tar -C /workspace -xf - && if [ -n \"$MAVEN_SETTINGS_XML\" ]; then mkdir -p /tmp/codegen /workspace/.mvn && printf '%s' \"$MAVEN_SETTINGS_XML\" > /tmp/codegen/settings.xml && printf '\n--settings\n/tmp/codegen/settings.xml\n--no-transfer-progress\n' >> /workspace/.mvn/maven.config; fi",
                ],
                env: mavenMirrorUrl
                  ? [
                      {
                        name: 'MAVEN_SETTINGS_XML',
                        value: mavenSettingsXml(mavenMirrorUrl),
                      },
                    ]
                  : [],
                resources: {
                  requests: {
                    cpu: '50m',
                    memory: '64Mi',
                    'ephemeral-storage': '64Mi',
                  },
                  limits: {
                    cpu: '500m',
                    memory: '512Mi',
                    'ephemeral-storage': this.config.get('K8S_GENERATION_EPHEMERAL_LIMIT', '2Gi'),
                  },
                },
                securityContext: {
                  allowPrivilegeEscalation: false,
                  capabilities: { drop: ['ALL'] },
                  readOnlyRootFilesystem: true,
                },
                volumeMounts: [
                  {
                    name: 'source',
                    mountPath: '/source',
                    subPath: this.workspaceSubPath(handle.volumePath),
                    readOnly: true,
                  },
                  {
                    name: 'workspace',
                    mountPath: '/workspace',
                  },
                  {
                    name: 'tmp',
                    mountPath: '/tmp',
                  },
                ],
              },
            ],
            volumes: [
              { name: 'source', persistentVolumeClaim: { claimName, readOnly: true } },
              {
                name: 'workspace',
                emptyDir: {
                  sizeLimit: this.config.get('K8S_GENERATION_BUILD_SIZE_LIMIT', '2Gi'),
                },
              },
              {
                name: 'tmp',
                emptyDir: {
                  sizeLimit: this.config.get('K8S_GENERATION_TMP_SIZE_LIMIT', '512Mi'),
                },
              },
            ],
          },
        },
      },
    };

    if (options.taskId) {
      await this.prisma.task.update({
        where: { id: options.taskId },
        data: {
          executorKind: 'kubernetes',
          executionNamespace: namespace,
          executionRef: name,
          failureCode: null,
        },
      });
    }
    let created = false;
    let streamed = '';
    try {
      await batchApi.createNamespacedJob({ namespace, body: job });
      created = true;
      this.logger.log(`已创建生成验证 Job ${namespace}/${name}`);
      while (true) {
        if (signal?.aborted) {
          await this.deleteJob(batchApi, namespace, name);
          signal.throwIfAborted();
        }
        const current = await batchApi.readNamespacedJob({ namespace, name });
        const currentLogs = await this.logs(coreApi, namespace, name, true);
        if (currentLogs.length > streamed.length) {
          const chunk = currentLogs.slice(streamed.length);
          streamed = currentLogs;
          options.onOutput?.(chunk);
        }
        if ((current.status?.succeeded ?? 0) > 0) {
          return { exitCode: 0, output: currentLogs, executorKind: 'kubernetes', executionRef: name, executionNamespace: namespace };
        }
        if ((current.status?.failed ?? 0) > 0) {
          const pods = await this.pods(coreApi, namespace, name);
          return {
            exitCode: podExitCode(pods) ?? 1,
            output: currentLogs || podFailureMessage(pods),
            executorKind: 'kubernetes',
            executionRef: name,
            executionNamespace: namespace,
            failureCode: classifyKubernetesFailure(current, pods),
          };
        }
        await abortableDelay(1000, signal);
      }
    } catch (error) {
      if (options.taskId && !signal?.aborted) {
        await this.prisma.task.update({
          where: { id: options.taskId },
          data: { failureCode: 'cluster_error' },
        }).catch(() => undefined);
      }
      throw error;
    } finally {
      if (created) await this.deleteJob(batchApi, namespace, name);
    }
  }

  private clients() {
    if (!this.batchApi || !this.coreApi) {
      const kubeConfig = new k8s.KubeConfig();
      kubeConfig.loadFromDefault();
      this.batchApi = kubeConfig.makeApiClient(k8s.BatchV1Api);
      this.coreApi = kubeConfig.makeApiClient(k8s.CoreV1Api);
    }
    return { batchApi: this.batchApi, coreApi: this.coreApi };
  }

  private workspaceSubPath(path: string) {
    const root = resolve(
      this.config.get('K8S_GENERATION_WORKSPACE_ROOT', '/data'),
    );
    const child = resolve(path);
    const subPath = relative(root, child);
    if (!subPath || subPath === '..' || subPath.startsWith(`..${sep}`)) {
      throw new BadRequestException(`工作区不在共享卷根目录内: ${child}`);
    }
    return subPath.split(sep).join('/');
  }

  private async pods(coreApi: k8s.CoreV1Api, namespace: string, job: string) {
    const pods = await coreApi.listNamespacedPod({
      namespace,
      labelSelector: `job-name=${job}`,
    });
    return pods.items;
  }

  private async logs(coreApi: k8s.CoreV1Api, namespace: string, job: string, quiet = false) {
    const name = (await this.pods(coreApi, namespace, job))[0]?.metadata?.name;
    if (!name) return quiet ? '' : 'Job 已结束，但未找到对应 Pod 日志';
    const maxBytes = Number(
      this.config.get('K8S_GENERATION_LOG_MAX_BYTES', 2 * 1024 * 1024),
    );
    return coreApi
      .readNamespacedPodLog({ namespace, name, tailLines: 5000, limitBytes: maxBytes })
      .then((output) => tailUtf8(output, maxBytes))
      .catch((error) => quiet ? '' : `读取 Job 日志失败: ${(error as Error).message}`);
  }

  private async deleteJob(api: k8s.BatchV1Api, namespace: string, name: string) {
    await api
      .deleteNamespacedJob({ namespace, name, propagationPolicy: 'Background' })
      .catch(() => undefined);
  }
}

export function classifyKubernetesFailure(job: k8s.V1Job, pods: k8s.V1Pod[]): GenerationFailureCode {
  const reasons = pods.flatMap((pod) => [
    pod.status?.reason,
    ...allContainerStatuses(pod).flatMap((container) => [
      container.state?.waiting?.reason,
      container.state?.terminated?.reason,
    ]),
  ]).filter(Boolean);
  if (reasons.some((reason) => ['ErrImagePull', 'ImagePullBackOff', 'InvalidImageName'].includes(reason!))) return 'image_pull';
  if (reasons.includes('OOMKilled')) return 'oom_killed';
  const messages = pods.flatMap((pod) => [
    pod.status?.message,
    ...allContainerStatuses(pod).flatMap((container) => [
      container.state?.waiting?.message,
      container.state?.terminated?.message,
    ]),
  ]).filter(Boolean).join(' ');
  if (/ephemeral-storage|disk quota|no space left/i.test(messages)) return 'disk_limit';
  if (reasons.includes('Evicted')) return 'evicted';
  if (job.status?.conditions?.some((item) => item.reason === 'DeadlineExceeded')) return 'deadline_exceeded';
  if (podExitCode(pods) != null) return 'command_failed';
  return 'job_failed';
}

function podExitCode(pods: k8s.V1Pod[]) {
  for (const pod of pods) {
    for (const status of allContainerStatuses(pod)) {
      const code = status.state?.terminated?.exitCode;
      if (code != null) return code;
    }
  }
  return undefined;
}

function podFailureMessage(pods: k8s.V1Pod[]) {
  for (const pod of pods) {
    if (pod.status?.message) return pod.status.message;
    for (const status of allContainerStatuses(pod)) {
      const state = status.state?.waiting ?? status.state?.terminated;
      if (state?.message) return state.message;
      if (state?.reason) return state.reason;
    }
  }
  return 'Kubernetes Job 执行失败，未返回容器日志';
}

function allContainerStatuses(pod: k8s.V1Pod) {
  return [
    ...(pod.status?.initContainerStatuses ?? []),
    ...(pod.status?.containerStatuses ?? []),
  ];
}

function safeName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 20);
}

function safeLabel(value: string) {
  const label = String(value).toLowerCase().replace(/[^a-z0-9_.-]/g, '-').slice(0, 63);
  return label || 'codegen';
}

function parseCsv(value: string) {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function parseJsonRecord(value: string, key: string): Record<string, string> {
  const parsed = parseJson<Record<string, unknown>>(value, key);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((item) => typeof item !== 'string')
  ) {
    throw new BadRequestException(`${key} 必须是字符串键值 JSON 对象`);
  }
  return parsed as Record<string, string>;
}

function parseJsonArray<T>(value: string, key: string): T[] {
  const parsed = parseJson<unknown>(value, key);
  if (!Array.isArray(parsed)) throw new BadRequestException(`${key} 必须是 JSON 数组`);
  return parsed as T[];
}

function parseJson<T>(value: string, key: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new BadRequestException(`${key} 不是合法 JSON`);
  }
}

function tailUtf8(value: string, maxBytes: number) {
  const buffer = Buffer.from(value, 'utf8');
  return buffer.length <= maxBytes
    ? value
    : buffer.subarray(buffer.length - maxBytes).toString('utf8');
}

function mavenSettingsXml(mirrorUrl: string) {
  const url = escapeXml(mirrorUrl);
  return `<settings><mirrors><mirror><id>codegen-mirror</id><name>Codegen managed mirror</name><url>${url}</url><mirrorOf>*</mirrorOf></mirror></mirrors></settings>`;
}

function escapeXml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function abortableDelay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolveDelay, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('任务已取消'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolveDelay();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
