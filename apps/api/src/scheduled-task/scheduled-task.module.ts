import { Module } from '@nestjs/common';
import { ScheduledTaskController, JavaTaskRegistrationController } from './scheduled-task.controller';
import { ScheduledTaskService } from './scheduled-task.service';
import { PrismaModule } from '../prisma/prisma.module';
import { CryptoService } from '../crypto/crypto.service';

@Module({
  imports: [PrismaModule],
  controllers: [ScheduledTaskController, JavaTaskRegistrationController],
  providers: [ScheduledTaskService, CryptoService],
  exports: [ScheduledTaskService],
})
export class ScheduledTaskModule {}
