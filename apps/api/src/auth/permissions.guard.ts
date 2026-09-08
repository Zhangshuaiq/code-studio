import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from './require-permissions.decorator';
import { AuthUser } from './jwt.strategy';

// 校验 req.user.permissions 是否覆盖接口要求的权限。需搭配 JwtAuthGuard 先跑（填充 req.user）。
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!required || required.length === 0) return true;

    const user = ctx.switchToHttp().getRequest().user as AuthUser | undefined;
    const perms = user?.permissions ?? [];
    const ok = required.every((p) => perms.includes(p));
    if (!ok) throw new ForbiddenException('权限不足');
    return true;
  }
}
