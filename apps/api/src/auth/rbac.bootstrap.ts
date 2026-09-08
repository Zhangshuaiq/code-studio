import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BUILTIN_ROLES } from './permissions';

// 启动时幂等初始化 RBAC：
//  - 内置角色按名 upsert（权限每次同步为代码里的定义，新增权限自动下发到 admin）
// 首次管理员必须通过 INITIAL_ADMIN_TOKEN 显式初始化，启动过程不再自动提权用户。
@Injectable()
export class RbacBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger(RbacBootstrap.name);
  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap() {
    try {
      for (const r of BUILTIN_ROLES) {
        await this.prisma.role.upsert({
          where: { name: r.name },
          create: {
            name: r.name,
            description: r.description,
            permissions: r.permissions,
            builtin: true,
          },
          update: {
            description: r.description,
            permissions: r.permissions,
            builtin: true,
          },
        });
      }
    } catch (e) {
      this.logger.error(`RBAC bootstrap 失败: ${String(e)}`);
    }
  }
}
