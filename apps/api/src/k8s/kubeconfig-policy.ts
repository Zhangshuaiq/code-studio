import { BadRequestException } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';

/** kubeconfig 来自管理端输入，禁止任何会访问 API 进程本地环境的认证方式。 */
export function assertSafeKubeconfig(value: string): void {
  try {
    const kc = new k8s.KubeConfig();
    kc.loadFromString(value);
    const cluster = kc.getCurrentCluster();
    if (!kc.getCurrentContext() || !cluster?.server || !kc.getCurrentUser()) {
      throw new Error('缺少 current-context、当前用户或集群地址');
    }
    let server: URL;
    try { server = new URL(cluster.server); }
    catch { throw new Error('集群地址格式不正确'); }
    if (server.protocol !== 'https:' || server.username || server.password || server.search || server.hash) {
      throw new Error('集群地址必须是无内嵌凭据、查询参数或锚点的 HTTPS URL');
    }
    if (cluster.skipTLSVerify) throw new Error('禁止跳过 Kubernetes API Server TLS 校验');
    if (cluster.caFile || cluster.proxyUrl) throw new Error('禁止引用本地 CA 文件或 kubeconfig 内代理');
    for (const user of kc.getUsers()) {
      if (user.exec || user.authProvider) throw new Error('禁止使用 exec 或 auth-provider 认证插件');
      if (user.certFile || user.keyFile) throw new Error('禁止引用本地客户端证书或密钥文件');
      if (user.impersonateUser) throw new Error('禁止通过 kubeconfig 冒充其他 Kubernetes 用户');
    }
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException({
      code: 'DEPLOY_TARGET_KUBECONFIG_UNSAFE',
      message: `kubeconfig 不安全或无法解析：${String((error as Error).message)}`,
    });
  }
}
