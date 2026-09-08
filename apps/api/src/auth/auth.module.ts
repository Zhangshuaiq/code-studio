import { Module } from '@nestjs/common';
import { JwtModule, type JwtModuleOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './jwt.strategy';
import { RbacBootstrap } from './rbac.bootstrap';
import { buildJwtKeyRing } from './jwt-keys';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService): JwtModuleOptions => {
        const ring = buildJwtKeyRing({
          activeId: config.get<string>('JWT_KEY_ID'),
          activeSecret: config.get<string>('JWT_SECRET'),
          previous: config.get<string>('JWT_PREVIOUS_SECRETS'),
        });
        return {
        secret: ring.activeSecret,
        signOptions: {
          keyid: ring.activeId,
          expiresIn: config.get<string>(
            'JWT_EXPIRES_IN',
            '7d',
          ) as NonNullable<JwtModuleOptions['signOptions']>['expiresIn'],
        },
      };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, RbacBootstrap],
  exports: [AuthService],
})
export class AuthModule {}
