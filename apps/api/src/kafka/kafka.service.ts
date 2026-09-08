import { BadRequestException, ConflictException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AssignerProtocol, ConfigResourceTypes, Kafka, logLevel, type KafkaConfig } from 'kafkajs';
import { KafkaCreateTopicDto, KafkaDeleteRecordsDto, KafkaMessageQueryDto, KafkaProduceDto, KafkaSetOffsetsDto, KafkaTopicConfigDto } from './dto/kafka.dto';
import { diagnosticMessage } from '../common/redact-diagnostic';

const TOPIC_RE = /^[A-Za-z0-9._-]{1,249}$/;
const MAX_RENDER_BYTES = 64 * 1024;
const MAX_LIST_ITEMS = 500;
const DEFAULT_INSPECTOR_GROUP = 'codegen-console-inspector';
const MESSAGE_WINDOWS = [
  { key: '5m', milliseconds: 5 * 60_000 },
  { key: '1h', milliseconds: 60 * 60_000 },
  { key: '24h', milliseconds: 24 * 60 * 60_000 },
] as const;

@Injectable()
export class KafkaService {
  constructor(private readonly config: ConfigService) {}

  async topics(limit = MAX_LIST_ITEMS) {
    return this.withAdmin(async (admin) => {
      const allNames = (await admin.listTopics()).sort();
      const names = allNames.slice(0, Math.min(MAX_LIST_ITEMS, Math.max(1, limit)));
      if (!names.length) return { items: [], total: 0, truncated: false };
      const metadata = await admin.fetchTopicMetadata({ topics: names });
      const offsetEntries = await Promise.all(names.map(async (topic) => [topic, await admin.fetchTopicOffsets(topic)] as const));
      const offsets = new Map(offsetEntries);
      const items = metadata.topics.map((topic) => ({
        name: topic.name,
        internal: topic.name.startsWith('__'),
        partitions: topic.partitions.map((partition) => ({
          partition: partition.partitionId,
          leader: partition.leader,
          replicas: partition.replicas,
          isr: partition.isr,
          low: offsets.get(topic.name)?.find((item) => item.partition === partition.partitionId)?.low ?? '0',
          high: offsets.get(topic.name)?.find((item) => item.partition === partition.partitionId)?.high ?? '0',
        })),
      }));
      return { items, total: allNames.length, truncated: allNames.length > names.length };
    });
  }

  async groups(limit = MAX_LIST_ITEMS) {
    return this.withAdmin(async (admin) => {
      const allGroups = (await admin.listGroups()).groups;
      const groups = allGroups.slice(0, Math.min(MAX_LIST_ITEMS, Math.max(1, limit)));
      if (!groups.length) return { items: [], total: 0, truncated: false };
      const detail = await admin.describeGroups(groups.map((group) => group.groupId));
      const items = detail.groups.map((group) => {
        const rebalancing = group.state === 'PreparingRebalance' || group.state === 'CompletingRebalance';
        const consumers = group.members.map((member) => {
          const assignment = decodeMemberAssignment(member.memberAssignment);
          const partitionCount = assignment.reduce((total, item) => total + item.partitions.length, 0);
          return {
            memberId: member.memberId,
            clientId: member.clientId,
            clientHost: member.clientHost,
            status: rebalancing ? 'rebalancing' : partitionCount > 0 ? 'working' : 'idle',
            partitionCount,
            assignment,
          };
        });
        return {
          groupId: group.groupId,
          state: group.state,
          protocol: group.protocol,
          protocolType: group.protocolType,
          members: consumers.length,
          consumers,
        };
      });
      return { items, total: allGroups.length, truncated: allGroups.length > groups.length };
    });
  }

  async groupOffsets(groupId: string) {
    this.assertGroup(groupId);
    return this.withAdmin((admin) => admin.fetchOffsets({ groupId }));
  }

  async topicMetrics(topic: string) {
    this.assertTopic(topic);
    return this.withAdmin(async (admin) => {
      const current = await admin.fetchTopicOffsets(topic);
      const now = Date.now();
      const starts = await Promise.all(MESSAGE_WINDOWS.map(({ milliseconds }) =>
        admin.fetchTopicOffsetsByTimestamp(topic, now - milliseconds)));
      const partitions = current.map((item) => {
        const low = offsetValue(item.low);
        const high = offsetValue(item.high);
        const windows = Object.fromEntries(MESSAGE_WINDOWS.map(({ key }, index) => {
          const rawStart = starts[index].find((candidate) => candidate.partition === item.partition)?.offset;
          const start = rawStart == null || rawStart === '-1' ? high : clampOffset(offsetValue(rawStart), low, high);
          return [key, (high - start).toString()];
        }));
        return { partition: item.partition, low: item.low, high: item.high, retained: (high - low).toString(), windows };
      });
      return {
        topic,
        measuredAt: new Date(now).toISOString(),
        retained: sumOffsets(partitions.map((item) => item.retained)),
        windows: Object.fromEntries(MESSAGE_WINDOWS.map(({ key }) => [key, sumOffsets(partitions.map((item) => item.windows[key]))])),
        partitions,
      };
    });
  }

  async topicConfig(topic: string) {
    this.assertTopic(topic);
    return this.withAdmin(async (admin) => {
      const result = await admin.describeConfigs({
        includeSynonyms: false,
        resources: [{ type: ConfigResourceTypes.TOPIC, name: topic }],
      });
      const resource = result.resources[0];
      return {
        topic,
        entries: (resource?.configEntries ?? []).map((entry) => ({
          name: entry.configName,
          value: entry.isSensitive ? null : entry.configValue,
          readOnly: entry.readOnly,
          isDefault: entry.isDefault,
          source: entry.configSource,
          sensitive: entry.isSensitive,
        })).sort((left, right) => left.name.localeCompare(right.name)),
      };
    });
  }

  async groupLag(groupId: string, limit = MAX_LIST_ITEMS) {
    this.assertGroup(groupId);
    return this.withAdmin(async (admin) => {
      const committedTopics = await admin.fetchOffsets({ groupId });
      const topics = committedTopics.slice(0, Math.min(MAX_LIST_ITEMS, Math.max(1, limit)));
      const latest = new Map<string, Awaited<ReturnType<typeof admin.fetchTopicOffsets>>>();
      for (let index = 0; index < topics.length; index += 20) {
        const batch = topics.slice(index, index + 20);
        const offsets = await Promise.all(batch.map(async (item) => [item.topic, await admin.fetchTopicOffsets(item.topic)] as const));
        offsets.forEach(([topic, partitions]) => latest.set(topic, partitions));
      }
      const topicItems = topics.map((item) => {
        const current = latest.get(item.topic) ?? [];
        const partitions = item.partitions.map((partition) => {
          const range = current.find((candidate) => candidate.partition === partition.partition);
          const low = offsetValue(range?.low ?? '0');
          const high = offsetValue(range?.high ?? '0');
          const committed = partition.offset === '-1' ? low : clampOffset(offsetValue(partition.offset), low, high);
          return {
            partition: partition.partition,
            committed: partition.offset,
            low: low.toString(),
            high: high.toString(),
            lag: (high - committed).toString(),
          };
        });
        return { topic: item.topic, lag: sumOffsets(partitions.map((partition) => partition.lag)), partitions };
      });
      return {
        groupId,
        measuredAt: new Date().toISOString(),
        lag: sumOffsets(topicItems.map((item) => item.lag)),
        topics: topicItems,
        truncated: committedTopics.length > topics.length,
      };
    });
  }

  async sample(topic: string, query: KafkaMessageQueryDto) {
    this.assertTopic(topic);
    const kafka = this.client();
    const consumer = kafka.consumer({ groupId: this.inspectorGroupId(), allowAutoTopicCreation: false });
    const messages: Array<Record<string, unknown>> = [];
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const timeout = setTimeout(finish, 5_000);
    timeout.unref();
    try {
      await consumer.connect();
      await consumer.subscribe({ topic, fromBeginning: query.fromBeginning });
      await consumer.run({
        autoCommit: false,
        eachMessage: async ({ partition, message }) => {
          if (query.partition != null && partition !== query.partition) return;
          messages.push({
            partition,
            offset: message.offset,
            timestamp: message.timestamp,
            key: renderBuffer(message.key),
            value: renderBuffer(message.value),
            headers: Object.fromEntries(Object.entries(message.headers ?? {}).map(([key, value]) => [key, renderBuffer(value)])),
          });
          if (messages.length >= query.limit) finish();
        },
      });
      await done;
      return { items: messages.slice(0, query.limit), truncated: messages.length >= query.limit, sampled: true };
    } catch (error) {
      throw this.kafkaError(error);
    } finally {
      clearTimeout(timeout);
      await consumer.disconnect().catch(() => undefined);
    }
  }

  async produce(topic: string, input: KafkaProduceDto) {
    this.assertTopic(topic);
    const producer = this.client().producer({ allowAutoTopicCreation: false });
    try {
      await producer.connect();
      const result = await producer.send({ topic, messages: [{ key: input.key, value: input.value, partition: input.partition }] });
      return { topic, records: result.map((item) => ({ partition: item.partition, offset: item.baseOffset })) };
    } catch (error) {
      throw this.kafkaError(error);
    } finally {
      await producer.disconnect().catch(() => undefined);
    }
  }

  async createTopic(input: KafkaCreateTopicDto) {
    this.assertTopic(input.topic);
    if (input.minInsyncReplicas != null && input.minInsyncReplicas > input.replicationFactor) {
      throw new BadRequestException({ code: 'KAFKA_CONFIG_INCOMPATIBLE', message: `最小同步副本数不能超过新 Topic 副本数 ${input.replicationFactor}` });
    }
    return this.withAdmin(async (admin) => {
      const created = await admin.createTopics({ waitForLeaders: true, topics: [{ topic: input.topic, numPartitions: input.partitions, replicationFactor: input.replicationFactor, configEntries: topicConfigEntries(input) }] });
      if (!created) throw new ConflictException({ code: 'KAFKA_TOPIC_ALREADY_EXISTS', message: 'Topic 已存在' });
      return { created: true, topic: input.topic };
    });
  }

  async increasePartitions(topic: string, count: number) {
    this.assertTopic(topic);
    return this.withAdmin(async (admin) => { await admin.createPartitions({ validateOnly: false, topicPartitions: [{ topic, count }] }); return { topic, partitions: count }; });
  }

  async updateTopicConfig(topic: string, input: KafkaTopicConfigDto) {
    this.assertTopic(topic);
    const configEntries = topicConfigEntries(input);
    if (!configEntries.length) throw new BadRequestException({ code: 'KAFKA_CONFIG_EMPTY', message: '至少提供一个 Topic 配置项' });
    return this.withAdmin(async (admin) => {
      const [metadata, described] = await Promise.all([
        admin.fetchTopicMetadata({ topics: [topic] }),
        admin.describeConfigs({ includeSynonyms: false, resources: [{ type: ConfigResourceTypes.TOPIC, name: topic }] }),
      ]);
      const partitions = metadata.topics[0]?.partitions ?? [];
      const replicationFactor = partitions.reduce((minimum, partition) => Math.min(minimum, partition.replicas.length), partitions[0]?.replicas.length ?? 0);
      if (input.minInsyncReplicas != null && replicationFactor > 0 && input.minInsyncReplicas > replicationFactor) {
        throw new BadRequestException({ code: 'KAFKA_CONFIG_INCOMPATIBLE', message: `最小同步副本数不能超过 Topic 副本数 ${replicationFactor}` });
      }
      const current = new Map((described.resources[0]?.configEntries ?? []).map((entry) => [entry.configName, entry.configValue]));
      const minLag = input.minCompactionLagMs ?? numericConfig(current.get('min.compaction.lag.ms'), 0);
      const maxLag = input.maxCompactionLagMs ?? numericConfig(current.get('max.compaction.lag.ms'), Number.MAX_SAFE_INTEGER);
      if (minLag > maxLag) {
        throw new BadRequestException({ code: 'KAFKA_CONFIG_INCOMPATIBLE', message: '最小压缩延迟不能大于最大压缩延迟' });
      }
      await admin.alterConfigs({ validateOnly: false, resources: [{ type: ConfigResourceTypes.TOPIC, name: topic, configEntries }] });
      return { topic, updated: configEntries.map((item) => item.name) };
    });
  }

  async deleteTopic(topic: string, confirmation: string) {
    this.assertConfirmation(topic, confirmation);
    return this.withAdmin(async (admin) => { await admin.deleteTopics({ topics: [topic], timeout: 15_000 }); return { topic, deleted: true }; });
  }

  async deleteRecords(topic: string, input: KafkaDeleteRecordsDto) {
    this.assertConfirmation(topic, input.confirmation);
    if (!/^\d+$/.test(input.offset)) throw new BadRequestException({ code: 'KAFKA_OFFSET_INVALID', message: 'Offset 必须是非负整数字符串' });
    return this.withAdmin(async (admin) => { await admin.deleteTopicRecords({ topic, partitions: [{ partition: input.partition, offset: input.offset }] }); return { topic, partition: input.partition, beforeOffsetDeleted: input.offset }; });
  }

  async deleteGroup(groupId: string, confirmation: string) {
    this.assertMutableGroup(groupId);
    this.assertConfirmation(groupId, confirmation);
    return this.withAdmin(async (admin) => { const result = await admin.deleteGroups([groupId]); return { groupId, result }; });
  }

  async setGroupOffsets(groupId: string, input: KafkaSetOffsetsDto) {
    this.assertMutableGroup(groupId);
    this.assertConfirmation(groupId, input.confirmation);
    this.assertTopic(input.topic);
    if (!input.offsets.length || input.offsets.length > 1_000 || input.offsets.some((item) => !/^\d+$/.test(item.offset))) throw new BadRequestException({ code: 'KAFKA_OFFSET_INVALID', message: 'Offset 列表必须包含 1-1000 个非负整数位点' });
    return this.withAdmin(async (admin) => { await admin.setOffsets({ groupId, topic: input.topic, partitions: input.offsets }); return { groupId, topic: input.topic, offsets: input.offsets }; });
  }

  private async withAdmin<T>(work: (admin: ReturnType<Kafka['admin']>) => Promise<T>) {
    const admin = this.client().admin();
    try { await admin.connect(); return await work(admin); }
    catch (error) { if (error instanceof HttpException) throw error; throw this.kafkaError(error); }
    finally { await admin.disconnect().catch(() => undefined); }
  }

  private client() {
    const brokers = this.config.get<string>('KAFKA_BROKERS', '').split(',').map((v) => v.trim()).filter(Boolean);
    if (!brokers.length) throw new BadRequestException({ code: 'KAFKA_NOT_CONFIGURED', message: 'Kafka 集群尚未配置' });
    const mechanism = this.config.get<string>('KAFKA_SASL_MECHANISM', 'plain');
    const username = this.config.get<string>('KAFKA_SASL_USERNAME', '');
    const password = this.config.get<string>('KAFKA_SASL_PASSWORD', '');
    const sasl = username && password ? { mechanism: mechanism as 'plain' | 'scram-sha-256' | 'scram-sha-512', username, password } : undefined;
    const sslEnabled = this.config.get('KAFKA_SSL', 'true') === 'true';
    const ca = this.config.get<string>('KAFKA_SSL_CA', '');
    const cert = this.config.get<string>('KAFKA_SSL_CERT', '');
    const key = this.config.get<string>('KAFKA_SSL_KEY', '');
    const ssl = sslEnabled ? (ca || cert || key ? { rejectUnauthorized: true, ...(ca ? { ca: [ca] } : {}), ...(cert ? { cert } : {}), ...(key ? { key } : {}) } : true) : false;
    const options: KafkaConfig = { clientId: this.config.get('KAFKA_CLIENT_ID', 'codegen-console'), brokers, ssl, sasl, connectionTimeout: 10_000, requestTimeout: 15_000, logLevel: logLevel.NOTHING };
    return new Kafka(options);
  }

  private assertTopic(topic: string) { if (!TOPIC_RE.test(topic)) throw new BadRequestException({ code: 'KAFKA_TOPIC_INVALID', message: 'Kafka Topic 名称非法' }); }
  private assertGroup(groupId: string) { if (!groupId || groupId.length > 255 || /[\u0000-\u001f\u007f]/.test(groupId)) throw new BadRequestException({ code: 'KAFKA_GROUP_INVALID', message: 'Consumer Group 名称非法' }); }
  private assertConfirmation(resource: string, confirmation: string) { if (resource !== confirmation) throw new BadRequestException({ code: 'KAFKA_CONFIRMATION_MISMATCH', message: '确认文本必须与资源名称完全一致' }); }
  private inspectorGroupId() { return this.config.get<string>('KAFKA_INSPECTOR_GROUP_ID', DEFAULT_INSPECTOR_GROUP).trim() || DEFAULT_INSPECTOR_GROUP; }
  private assertMutableGroup(groupId: string) { if (groupId === this.inspectorGroupId()) throw new BadRequestException({ code: 'KAFKA_INTERNAL_GROUP_PROTECTED', message: '平台消息检查 Consumer Group 不允许修改或删除' }); }
  private kafkaError(error: unknown) { return new ServiceUnavailableException({ code: 'KAFKA_UNAVAILABLE', message: `Kafka 操作失败：${diagnosticMessage(error)}` }); }
}

function offsetValue(value: string) {
  try { return BigInt(value); }
  catch { return 0n; }
}

function clampOffset(value: bigint, low: bigint, high: bigint) {
  return value < low ? low : value > high ? high : value;
}

function sumOffsets(values: string[]) {
  return values.reduce((total, value) => total + offsetValue(value), 0n).toString();
}

function numericConfig(value: string | null | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function decodeMemberAssignment(value: Buffer) {
  try {
    const decoded = AssignerProtocol.MemberAssignment.decode(value);
    return Object.entries(decoded.assignment).map(([topic, partitions]) => ({ topic, partitions }));
  } catch {
    return [] as Array<{ topic: string; partitions: number[] }>;
  }
}

function topicConfigEntries(input: KafkaTopicConfigDto) {
  return [
    ...(input.retentionMs != null ? [{ name: 'retention.ms', value: String(input.retentionMs) }] : []),
    ...(input.retentionBytes != null ? [{ name: 'retention.bytes', value: String(input.retentionBytes) }] : []),
    ...(input.maxMessageBytes != null ? [{ name: 'max.message.bytes', value: String(input.maxMessageBytes) }] : []),
    ...(input.cleanupPolicy != null ? [{ name: 'cleanup.policy', value: input.cleanupPolicy }] : []),
    ...(input.segmentMs != null ? [{ name: 'segment.ms', value: String(input.segmentMs) }] : []),
    ...(input.segmentBytes != null ? [{ name: 'segment.bytes', value: String(input.segmentBytes) }] : []),
    ...(input.minInsyncReplicas != null ? [{ name: 'min.insync.replicas', value: String(input.minInsyncReplicas) }] : []),
    ...(input.compressionType != null ? [{ name: 'compression.type', value: input.compressionType }] : []),
    ...(input.deleteRetentionMs != null ? [{ name: 'delete.retention.ms', value: String(input.deleteRetentionMs) }] : []),
    ...(input.maxCompactionLagMs != null ? [{ name: 'max.compaction.lag.ms', value: String(input.maxCompactionLagMs) }] : []),
    ...(input.minCompactionLagMs != null ? [{ name: 'min.compaction.lag.ms', value: String(input.minCompactionLagMs) }] : []),
    ...(input.messageTimestampType != null ? [{ name: 'message.timestamp.type', value: input.messageTimestampType }] : []),
  ];
}

function renderBuffer(value?: unknown): string | string[] | null {
  if (!value) return null;
  if (Array.isArray(value)) return value.map(renderBuffer).filter((item): item is string => typeof item === 'string');
  if (typeof value === 'string') return value;
  if (!Buffer.isBuffer(value)) return String(value);
  if (value.length > MAX_RENDER_BYTES) return `[内容超过 ${MAX_RENDER_BYTES} 字节，已隐藏]`;
  const text = value.toString('utf8');
  return text.includes('\uFFFD') ? `base64:${value.toString('base64')}` : text;
}
