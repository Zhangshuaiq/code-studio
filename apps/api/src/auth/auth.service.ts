import {
  ForbiddenException,
  Injectable,
  ConflictException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

export interface JwtPayload {
  sub: string;
  username: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async register(dto: RegisterDto) {
    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = await this.prisma.$transaction(async (tx) => {
      // 串行化首次管理员创建，避免两个并发注册同时通过“尚无管理员”的判断。
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(918273645)`;
      const existing = await tx.user.findUnique({ where: { username: dto.username } });
      if (existing) throw new ConflictException('用户名已存在');

      const adminCount = await tx.user.count({
        where: { roles: { some: { name: 'admin' } } },
      });
      const firstAdmin = adminCount === 0;
      if (firstAdmin) {
        const expected = this.config.get<string>('INITIAL_ADMIN_TOKEN', '');
        if (!expected) {
          throw new ServiceUnavailableException(
            '平台尚未初始化管理员，且服务端未配置 INITIAL_ADMIN_TOKEN',
          );
        }
        if (!secureTokenEqual(dto.setupToken, expected)) {
          throw new ForbiddenException('管理员初始化令牌无效');
        }
      } else if (!this.selfRegistrationEnabled()) {
        throw new ForbiddenException('平台已关闭自助注册，请联系管理员创建账号');
      }

      const role = await tx.role.findUnique({
        where: {
          name: firstAdmin
            ? 'admin'
            : this.config.get<string>('SELF_REGISTRATION_ROLE', 'viewer'),
        },
      });
      if (!role) throw new ServiceUnavailableException('平台角色尚未初始化');
      return tx.user.create({
        data: {
          username: dto.username,
          passwordHash,
          roles: { connect: { id: role.id } },
        },
      });
    });

    return this.issueToken(user.id, user.username);
  }

  async registrationStatus() {
    const adminExists = (await this.prisma.user.count({
      where: { roles: { some: { name: 'admin' } } },
    })) > 0;
    return {
      enabled: adminExists ? this.selfRegistrationEnabled() : true,
      setupRequired: !adminExists,
    };
  }

  async login(dto: LoginDto) {
    // 登录标识可为用户名或邮箱（企业邮箱登录）
    const id = dto.username?.trim();
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ username: id }, { email: id }] },
    });
    if (!user) {
      throw new UnauthorizedException('用户名或密码错误');
    }
    if (user.status === 'disabled') {
      throw new UnauthorizedException('账户已被停用，请联系管理员');
    }

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('用户名或密码错误');
    }

    return this.issueToken(user.id, user.username);
  }

  private issueToken(userId: string, username: string) {
    const payload: JwtPayload = { sub: userId, username };
    return {
      accessToken: this.jwt.sign(payload),
      user: { id: userId, username },
    };
  }

  private selfRegistrationEnabled() {
    const configured = this.config.get<string>('SELF_REGISTRATION_ENABLED');
    if (configured != null) return configured === 'true';
    return this.config.get<string>('NODE_ENV', 'development') !== 'production';
  }
}

function secureTokenEqual(actual: string | undefined, expected: string) {
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
