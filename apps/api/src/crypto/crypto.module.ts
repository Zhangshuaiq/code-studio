import { Global, Module } from '@nestjs/common';
import { CryptoService } from './crypto.service';
import { CryptoRotationService } from './crypto-rotation.service';
import { CryptoAdminController } from './crypto-admin.controller';

@Global()
@Module({
  controllers: [CryptoAdminController],
  providers: [CryptoService, CryptoRotationService],
  exports: [CryptoService],
})
export class CryptoModule {}
