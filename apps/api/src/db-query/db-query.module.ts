import { Module } from '@nestjs/common';
import { DbQueryController } from './db-query.controller';
import { DbQueryService } from './db-query.service';
import { PrismaModule } from '../prisma/prisma.module';
import { CryptoService } from '../crypto/crypto.service';

@Module({
  imports: [PrismaModule],
  controllers: [DbQueryController],
  providers: [DbQueryService, CryptoService],
  exports: [DbQueryService],
})
export class DbQueryModule {}
