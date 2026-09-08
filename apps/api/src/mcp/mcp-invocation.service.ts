import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';
import { getRequestContext } from '../observability/request-context';
import type { McpPrincipal } from './mcp-server.factory';

@Injectable()
export class McpInvocationService {
  private readonly maxResultBytes: number;

  constructor(
    config: ConfigService,
    private readonly audit: AuditService,
  ) {
    this.maxResultBytes = Number(config.get('MCP_RESULT_MAX_BYTES', 1024 * 1024));
  }

  async execute(
    tool: string,
    principal: McpPrincipal,
    input: unknown,
    handler: () => Promise<unknown>,
  ) {
    const startedAt = Date.now();
    const inputHash = createHash('sha256').update(stableJson(input)).digest('hex');
    try {
      const value = await handler();
      const text = stringifyJson(value);
      const outputBytes = Buffer.byteLength(text, 'utf8');
      if (outputBytes > this.maxResultBytes) {
        throw new Error(`MCP 工具结果超过 ${this.maxResultBytes} 字节限制，请缩小查询范围`);
      }
      this.record(tool, principal, 'success', inputHash, startedAt, outputBytes);
      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: JSON.parse(text) as Record<string, unknown>,
      };
    } catch (error) {
      this.record(tool, principal, 'failure', inputHash, startedAt, undefined, error);
      throw error;
    }
  }

  private record(
    tool: string,
    principal: McpPrincipal,
    result: 'success' | 'failure',
    inputHash: string,
    startedAt: number,
    outputBytes?: number,
    error?: unknown,
  ) {
    const context = getRequestContext();
    this.audit.record({
      actorId: principal.id,
      actorName: principal.username,
      action: `mcp.${tool}`,
      resourceType: 'mcp-tool',
      resourceName: tool,
      result,
      method: 'MCP',
      path: '/api/mcp',
      detail: {
        requestId: context?.requestId,
        traceId: context?.traceId,
        clientId: principal.clientId,
        inputHash,
        durationMs: Date.now() - startedAt,
        outputBytes,
        error: error instanceof Error ? error.message : error ? String(error) : undefined,
      },
    });
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function stringifyJson(value: unknown) {
  return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item);
}
