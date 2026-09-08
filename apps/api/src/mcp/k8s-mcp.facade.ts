import { Injectable } from '@nestjs/common';
import { K8sService } from '../k8s/k8s.service';

@Injectable()
export class K8sMcpFacade {
  constructor(private readonly k8s: K8sService) {}

  targets(userId: string) {
    return this.k8s.getK8sTargets(userId, 200);
  }

  namespaces(userId: string, targetId: string, limit: number) {
    return this.k8s.listNamespaces(targetId, userId, limit);
  }

  pods(userId: string, targetId: string, namespace: string, limit: number) {
    return this.k8s.listPods(targetId, userId, namespace, limit);
  }

  deployments(userId: string, targetId: string, namespace: string, limit: number) {
    return this.k8s.listDeployments(targetId, userId, namespace, limit);
  }

  services(userId: string, targetId: string, namespace: string, limit: number) {
    return this.k8s.listServices(targetId, userId, namespace, limit);
  }
}
