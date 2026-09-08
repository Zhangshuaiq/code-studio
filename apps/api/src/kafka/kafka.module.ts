import { Module } from '@nestjs/common';
import { KafkaController } from './kafka.controller';
import { KafkaService } from './kafka.service';
@Module({ controllers: [KafkaController], providers: [KafkaService], exports: [KafkaService] })
export class KafkaModule {}
