import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { PERMISSIONS } from '../auth/permissions';
import { Audit } from '../audit/audit.decorator';
import { KafkaService } from './kafka.service';
import { KafkaConfirmationDto, KafkaCreateTopicDto, KafkaDeleteRecordsDto, KafkaIncreasePartitionsDto, KafkaMessageQueryDto, KafkaProduceDto, KafkaSetOffsetsDto, KafkaTopicConfigDto } from './dto/kafka.dto';

@Controller('kafka')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class KafkaController {
  constructor(private readonly kafka: KafkaService) {}
  @Get('topics') @RequirePermissions(PERMISSIONS.KAFKA_READ) topics() { return this.kafka.topics(); }
  @Get('groups') @RequirePermissions(PERMISSIONS.KAFKA_READ) groups() { return this.kafka.groups(); }
  @Get('groups/:groupId/offsets') @RequirePermissions(PERMISSIONS.KAFKA_READ) groupOffsets(@Param('groupId') groupId:string){return this.kafka.groupOffsets(groupId);}
  @Get('groups/:groupId/lag') @RequirePermissions(PERMISSIONS.KAFKA_READ) groupLag(@Param('groupId') groupId:string){return this.kafka.groupLag(groupId);}
  @Get('topics/:topic/metrics') @RequirePermissions(PERMISSIONS.KAFKA_READ) topicMetrics(@Param('topic') topic:string){return this.kafka.topicMetrics(topic);}
  @Get('topics/:topic/config') @RequirePermissions(PERMISSIONS.KAFKA_READ) topicConfig(@Param('topic') topic:string){return this.kafka.topicConfig(topic);}
  @Get('topics/:topic/messages') @RequirePermissions(PERMISSIONS.KAFKA_READ) sample(@Param('topic') topic: string, @Query() query: KafkaMessageQueryDto) { return this.kafka.sample(topic, query); }
  @Post('topics/:topic/messages') @RequirePermissions(PERMISSIONS.KAFKA_PRODUCE) @Audit('kafka.message.produce', 'kafka-topic', false) produce(@Param('topic') topic: string, @Body() body: KafkaProduceDto) { return this.kafka.produce(topic, body); }
  @Post('topics') @RequirePermissions(PERMISSIONS.KAFKA_TOPIC_MANAGE) @Audit('kafka.topic.create', 'kafka-topic') createTopic(@Body() body: KafkaCreateTopicDto) { return this.kafka.createTopic(body); }
  @Patch('topics/:topic/partitions') @RequirePermissions(PERMISSIONS.KAFKA_TOPIC_MANAGE) @Audit('kafka.topic.partitions.increase', 'kafka-topic') partitions(@Param('topic') topic:string,@Body() body:KafkaIncreasePartitionsDto){return this.kafka.increasePartitions(topic,body.count);}
  @Patch('topics/:topic/config') @RequirePermissions(PERMISSIONS.KAFKA_TOPIC_MANAGE) @Audit('kafka.topic.config.update', 'kafka-topic') config(@Param('topic') topic:string,@Body() body:KafkaTopicConfigDto){return this.kafka.updateTopicConfig(topic,body);}
  @Delete('topics/:topic') @RequirePermissions(PERMISSIONS.KAFKA_TOPIC_MANAGE) @Audit('kafka.topic.delete', 'kafka-topic') deleteTopic(@Param('topic') topic:string,@Body() body:KafkaConfirmationDto){return this.kafka.deleteTopic(topic,body.confirmation);}
  @Post('topics/:topic/delete-records') @RequirePermissions(PERMISSIONS.KAFKA_TOPIC_MANAGE) @Audit('kafka.topic.records.delete', 'kafka-topic') deleteRecords(@Param('topic') topic:string,@Body() body:KafkaDeleteRecordsDto){return this.kafka.deleteRecords(topic,body);}
  @Delete('groups/:groupId') @RequirePermissions(PERMISSIONS.KAFKA_GROUP_MANAGE) @Audit('kafka.group.delete', 'kafka-group') deleteGroup(@Param('groupId') groupId:string,@Body() body:KafkaConfirmationDto){return this.kafka.deleteGroup(groupId,body.confirmation);}
  @Patch('groups/:groupId/offsets') @RequirePermissions(PERMISSIONS.KAFKA_GROUP_MANAGE) @Audit('kafka.group.offsets.set', 'kafka-group') offsets(@Param('groupId') groupId:string,@Body() body:KafkaSetOffsetsDto){return this.kafka.setGroupOffsets(groupId,body);}
}
