import { BadRequestException, Injectable } from '@nestjs/common';
import { DatasourceListQueryDto } from '../datasource/dto/datasource.dto';
import { DatasourceService } from '../datasource/datasource.service';
import { DbQueryService } from '../db-query/db-query.service';

@Injectable()
export class DatabaseMcpFacade {
  constructor(
    private readonly datasources: DatasourceService,
    private readonly queries: DbQueryService,
  ) {}

  async list(userId: string, input: { page: number; pageSize: number; category?: 'relational' | 'nosql' }) {
    const result = await this.datasources.listDatasources(
      userId,
      Object.assign(new DatasourceListQueryDto(), input),
    );
    return {
      ...result,
      items: result.items.map((item) => ({
        id: item.id,
        name: item.name,
        type: item.type,
        category: item.category,
        summary: item.summary,
        team: item.team,
        memberCount: item._count.members,
        approverCount: item._count.approvers,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      })),
    };
  }

  get(userId: string, datasourceId: string) {
    return this.datasources.getDatasourceSummary(datasourceId, userId);
  }

  async databases(userId: string, datasourceId: string) {
    const items = await this.queries.listDatabases(datasourceId, userId);
    return { datasourceId, items: items.slice(0, 200), truncated: items.length > 200 };
  }

  async tables(userId: string, datasourceId: string, database?: string) {
    const items = await this.queries.listTables(datasourceId, userId, database);
    return { datasourceId, database: database ?? null, items: items.slice(0, 500), truncated: items.length > 500 };
  }

  async describe(userId: string, datasourceId: string, tableName: string, database?: string) {
    const datasource = await this.datasources.getDatasourceSummary(datasourceId, userId);
    if (!['mysql', 'postgresql'].includes(datasource.type)) {
      throw new BadRequestException({
        code: 'MCP_DATABASE_SCHEMA_UNSUPPORTED',
        message: 'MCP 首版只支持读取 MySQL/PostgreSQL 表结构，不读取 MongoDB 示例业务文档',
      });
    }
    return {
      datasourceId,
      database: database ?? null,
      tableName,
      columns: await this.queries.describeTable(datasourceId, userId, tableName, database),
    };
  }
}
