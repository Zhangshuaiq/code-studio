import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { DeployModule } from '../deploy/deploy.module';

@Module({
  imports: [DeployModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
