import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { lastValueFrom, type Observable } from 'rxjs';
import { ProjectAccessService } from '../project-access/project-access.service';
import { DistributedWorkspaceLockService } from './distributed-workspace-lock.service';
import { WorkspaceService } from './workspace.service';

/** 对包含 :id Session 参数的 HTTP 写请求持有用户工作区锁直到响应完成。 */
@Injectable()
export class WorkspaceLockInterceptor implements NestInterceptor {
  constructor(
    private readonly access: ProjectAccessService,
    private readonly lock: DistributedWorkspaceLockService,
    private readonly workspaces: WorkspaceService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<{
      method: string;
      params?: { id?: string };
      user?: { id?: string };
    }>();
    if (request.method === 'GET' || !request.params?.id || !request.user?.id) return next.handle();

    return new Observable((subscriber) => {
      void this.access.requireSession(request.user!.id!, request.params!.id!, 'edit')
        .then(async (session) => {
          await this.workspaces.ensureForSession(request.user!.id!, request.params!.id!);
          return session;
        })
        .then((session) => this.lock.runExclusive(
          `workspace:${session.projectId}:${request.user!.id!}`,
          () => lastValueFrom(next.handle()),
        ))
        .then((value) => { subscriber.next(value); subscriber.complete(); })
        .catch((error) => subscriber.error(error));
    });
  }
}
