import { Body, Controller, Get, Ip, Post, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { CurrentUser } from './current-user.decorator';
import { AuthUser } from './jwt.strategy';
import { AuditService } from '../audit/audit.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  @Get('registration-status')
  registrationStatus() {
    return this.auth.registrationStatus();
  }

  @Post('register')
  async register(@Body() dto: RegisterDto, @Ip() ip: string) {
    const r = await this.auth.register(dto);
    this.audit.record({
      action: 'auth.register',
      resourceType: 'user',
      actorId: r.user.id,
      actorName: r.user.username,
      resourceId: r.user.id,
      resourceName: r.user.username,
      ip,
      path: '/auth/register',
      method: 'POST',
    });
    return r;
  }

  @Post('login')
  async login(@Body() dto: LoginDto, @Ip() ip: string) {
    try {
      const r = await this.auth.login(dto);
      this.audit.record({
        action: 'auth.login',
        resourceType: 'user',
        actorId: r.user.id,
        actorName: r.user.username,
        result: 'success',
        ip,
        path: '/auth/login',
        method: 'POST',
      });
      return r;
    } catch (e) {
      // 失败登录也留痕（安全审计），绝不记录密码
      this.audit.record({
        action: 'auth.login',
        resourceType: 'user',
        actorName: dto?.username || 'anonymous',
        result: 'failure',
        ip,
        path: '/auth/login',
        method: 'POST',
        detail: { reason: (e as Error).message },
      });
      throw e;
    }
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }
}
