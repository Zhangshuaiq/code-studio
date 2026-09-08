import { Module } from '@nestjs/common';
import { K8sController } from './k8s.controller';
import { K8sService } from './k8s.service';
import { PrismaModule } from '../prisma/prisma.module';
import { CryptoModule } from '../crypto/crypto.module';

@Module({
  imports: [PrismaModule, CryptoModule],
  controllers: [K8sController],
  providers: [K8sService],
  exports: [K8sService],
})
export class K8sModule {}
