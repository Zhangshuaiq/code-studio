import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from './auth.service';
import { buildJwtKeyRing, jwtKeyId } from './jwt-keys';

export interface AuthUser {
  id: string;
  username: string;
  email: string | null;
  roles: string[];
  permissions: string[];
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const ring = buildJwtKeyRing({
      activeId: config.get<string>('JWT_KEY_ID'),
      activeSecret: config.get<string>('JWT_SECRET'),
      previous: config.get<string>('JWT_PREVIOUS_SECRETS'),
    });
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKeyProvider: (_request, rawToken, done) => {
        const kid = jwtKeyId(rawToken);
        // 无 kid 的历史令牌仍按当前密钥验证，保证首次上线该能力时不强制用户退出。
        const secret = kid ? ring.keys.get(kid) : ring.activeSecret;
        if (!secret) return done(new Error(`未知 JWT key id: ${kid}`));
        done(null, secret);
      },
    });
  }

  // 每次请求按 token 里的 userId 从库里取最新角色→权限（角色变更即时生效；停用即拒）
  async validate(payload: JwtPayload): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: { roles: true },
    });
    if (!user) throw new UnauthorizedException('账户不存在');
    if (user.status === 'disabled')
      throw new UnauthorizedException('账户已被停用');

    const permissions = [...new Set(user.roles.flatMap((r) => r.permissions))];
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      roles: user.roles.map((r) => r.name),
      permissions,
    };
  }
}
