import { Injectable } from '@nestjs/common';
import { KafkaService } from '../kafka/kafka.service';

@Injectable()
export class KafkaMcpFacade {
  constructor(private readonly kafka: KafkaService) {}

  topics(limit: number) {
    return this.kafka.topics(limit);
  }

  topicMetrics(topic: string) {
    return this.kafka.topicMetrics(topic);
  }

  topicConfig(topic: string) {
    return this.kafka.topicConfig(topic);
  }

  groups(limit: number) {
    return this.kafka.groups(limit);
  }

  groupLag(groupId: string) {
    return this.kafka.groupLag(groupId, 100);
  }
}
