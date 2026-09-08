import { Injectable, BadRequestException, ConflictException, ForbiddenException, HttpException, NotFoundException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createConnection, Connection } from 'mysql2/promise';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { MongoClient } from 'mongodb';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { appendFile, mkdir, writeFile, stat, readFile, realpath, unlink } from 'fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';
import { hostname } from 'os';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { createReadStream } from 'fs';
import ExcelJS from 'exceljs';
import { parse as parseCsv } from 'csv-parse/sync';
import { ApprovalListQueryDto } from './dto/db-query.dto';
import { PageQueryDto, pageArgs, pageResult } from '../common/dto/page-query.dto';
import { diagnosticMessage, redactDiagnosticText } from '../common/redact-diagnostic';

interface DatasourceConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  database?: string;
  db?: number;
  authSource?: string;
}

interface TransferColumn { name: string; type: string; nullable: boolean }
interface NativeBackupManifest { version: 1; engine: 'mysql' | 'postgresql'; format: 'mysql-sql' | 'postgresql-custom'; database: string; tables: string[]; filename: string; size: number; sha256: string; createdAt: string }
interface QueryPayload {
  sql?: string;
  command?: string[];
  database?: string;
  collection?: string;
  operation?: string;
  query?: Record<string, unknown>;
}

@Injectable()
export class DbQueryService {
  private readonly logger = new Logger(DbQueryService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly configService: ConfigService,
  ) {}

  private get queryTimeoutMs() { return Number(this.configService.get('DB_QUERY_TIMEOUT_MS', 15_000)); }
  private get maxQueryRows() { return Number(this.configService.get('DB_QUERY_MAX_ROWS', 5_000)); }
  private get maxResultBytes() { return Number(this.configService.get('DB_QUERY_MAX_RESULT_BYTES', 5 * 1024 * 1024)); }
  private get maxExportBytes() { return Number(this.configService.get('DB_EXPORT_MAX_BYTES', 50 * 1024 * 1024)); }
  private get maxBackupBytes() { return Number(this.configService.get('DB_BACKUP_MAX_BYTES', 10 * 1024 * 1024 * 1024)); }

  // 获取数据源配置
  private async getDatasourceConfig(datasourceId: string, userId: string) {
    const datasource = await this.prisma.datasource.findFirst({
      where: {
        id: datasourceId,
        members: { some: { userId } }, // 必须被授权
      },
    });

    if (!datasource) {
      throw new BadRequestException('数据源不存在或无权访问');
    }

    const config = JSON.parse(
      this.crypto.decrypt(datasource.encryptedConfig),
    ) as DatasourceConfig;

    return { type: datasource.type, config };
  }

  // MySQL 查询
  private async queryMySQL(config: DatasourceConfig, sql: string, readOnly = false) {
    let connection: Connection | undefined;
    try {
      connection = await createConnection({
        host: config.host,
        port: config.port,
        user: config.username,
        password: config.password,
        database: config.database,
        connectTimeout: this.queryTimeoutMs,
      });

      if (readOnly) {
        await connection.query('SET SESSION TRANSACTION READ ONLY');
        await connection.query('START TRANSACTION READ ONLY');
        await connection.query(`SET SESSION MAX_EXECUTION_TIME=${this.queryTimeoutMs}`);
      }
      try {
        const [rows] = await connection.query({ sql, timeout: this.queryTimeoutMs });
        return readOnly ? this.enforceQueryResult(rows) : rows;
      } finally {
        if (readOnly) await connection.rollback().catch(() => undefined);
      }
    } finally {
      if (connection) await connection.end();
    }
  }

  // PostgreSQL 查询
  private async queryPostgreSQL(config: DatasourceConfig, sql: string, database?: string, readOnly = false) {
    const pool = new Pool({
      host: config.host,
      port: config.port,
      user: config.username,
      password: config.password,
      database: database || config.database,
      connectionTimeoutMillis: this.queryTimeoutMs,
      query_timeout: this.queryTimeoutMs,
      statement_timeout: this.queryTimeoutMs,
    });

    try {
      const client = await pool.connect();
      try {
        if (readOnly) await client.query('BEGIN READ ONLY');
        const result = await client.query(sql);
        return readOnly ? this.enforceQueryResult(result.rows) : result.rows;
      } finally {
        if (readOnly) await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    } finally {
      await pool.end();
    }
  }

  // Redis 命令
  private async queryRedis(config: DatasourceConfig, command: string[]) {
    if (!Array.isArray(command) || !command.length) throw new BadRequestException('Redis 命令不能为空');
    const commandName = String(command[0]).toUpperCase();
    if (!READ_ONLY_REDIS_COMMANDS.has(commandName)) {
      throw new ForbiddenException(`Redis 工作台仅允许只读命令，已拒绝 ${commandName}`);
    }
    const redis = new Redis({
      host: config.host,
      port: config.port,
      db: config.db || 0,
      connectTimeout: this.queryTimeoutMs,
      commandTimeout: this.queryTimeoutMs,
      maxRetriesPerRequest: 1,
    });

    try {
      const [cmd, ...args] = command;
      const result = await redis.call(cmd, ...args);
      return this.enforceQueryResult(result);
    } finally {
      redis.disconnect();
    }
  }

  // MongoDB 查询
  private async queryMongoDB(
    config: DatasourceConfig,
    database: string,
    collection: string,
    operation: string,
    query: Record<string, any> = {},
  ) {
    if (!READ_ONLY_MONGO_OPERATIONS.has(operation)) {
      throw new ForbiddenException(`MongoDB 工作台仅允许只读操作，已拒绝 ${operation || 'unknown'}`);
    }
    const uri = mongoUri(config, database);

    const client = new MongoClient(uri, {
      connectTimeoutMS: this.queryTimeoutMs,
      serverSelectionTimeoutMS: this.queryTimeoutMs,
      socketTimeoutMS: this.queryTimeoutMs,
    });

    try {
      await client.connect();
      const db = client.db(database);
      const coll = db.collection(collection);

      switch (operation) {
        case 'find':
          return this.enforceQueryResult(await coll.find(query.filter || {})
            .maxTimeMS(this.queryTimeoutMs)
            .limit(boundedLimit(query.limit, this.maxQueryRows))
            .toArray());
        case 'findOne':
          return this.enforceQueryResult(await coll.findOne(query.filter || {}, { maxTimeMS: this.queryTimeoutMs }));
        case 'countDocuments':
          return await coll.countDocuments(query.filter || {}, { maxTimeMS: this.queryTimeoutMs });
        default:
          throw new BadRequestException(`不支持的操作: ${operation}`);
      }
    } finally {
      await client.close();
    }
  }

  private enforceQueryResult<T>(value: T): T {
    if (Array.isArray(value) && value.length > this.maxQueryRows) {
      throw new BadRequestException(`查询结果超过 ${this.maxQueryRows} 行，请缩小查询范围`);
    }
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    if (bytes > this.maxResultBytes) {
      throw new BadRequestException(`查询结果超过 ${this.maxResultBytes} 字节，请缩小查询范围`);
    }
    return value;
  }

  // 执行查询
  async executeQuery(
    datasourceId: string,
    userId: string,
    payload: QueryPayload,
  ) {
    const { type, config } = await this.getDatasourceConfig(datasourceId, userId);

    try {
      switch (type) {
        case 'mysql':
        case 'postgresql': {
          const classification = classifySql(payload.sql);
          if (classification.requiresApproval) {
            const user = await this.prisma.user.findUnique({ where: { id: userId } });
            if (!user) throw new BadRequestException('用户不存在');
            const existing = await this.prisma.databaseApproval.findFirst({
              where: { datasourceId, requesterId: userId, database: payload.database ?? null, sql: payload.sql!.trim(), status: 'pending' },
            });
            const approval = existing ?? await this.prisma.databaseApproval.create({
              data: {
                datasourceId,
                requesterId: userId,
                requesterName: user.displayName || user.username,
                database: payload.database,
                sql: payload.sql!.trim(),
                operation: classification.operation,
              },
            });
            return { approvalRequired: true, approvalId: approval.id, status: approval.status, operation: classification.operation };
          }
          return type === 'mysql'
            ? this.queryMySQL(config, payload.sql!, true)
            : this.queryPostgreSQL(config, payload.sql!, payload.database, true);
        }
        case 'redis':
          return await this.queryRedis(config, payload.command ?? []);
        case 'mongodb':
          return await this.queryMongoDB(
            config,
            payload.database ?? '',
            payload.collection ?? '',
            payload.operation ?? '',
            payload.query ?? {},
          );
        default:
          throw new BadRequestException(`不支持的数据源类型: ${type}`);
      }
    } catch (error: unknown) {
      if (error instanceof HttpException) throw error;
      this.logger.warn(`数据源查询失败 datasource=${datasourceId} user=${userId}: ${errorMessage(error)}`);
      throw new BadRequestException('查询执行失败，请检查语句、连接状态或联系管理员查看服务端日志');
    }
  }

  async exportData(datasourceId: string, userId: string, input: { database: string; format?: string; scope?: string; table?: string; sql?: string }) {
    const { type, config } = await this.getDatasourceConfig(datasourceId, userId);
    if (!['mysql', 'postgresql'].includes(type)) throw new BadRequestException('仅关系型数据库支持表格导出');
    const format = input.format === 'xlsx' ? 'xlsx' : 'csv';
    let rows: Record<string, unknown>[];
    let label: string;
    if (input.scope === 'query') {
      const classification = classifySql(input.sql);
      if (classification.requiresApproval) throw new BadRequestException('只能导出只读查询结果');
      rows = (type === 'mysql'
        ? await this.queryMySQL({ ...config, database: input.database }, input.sql!)
        : await this.queryPostgreSQL(config, input.sql!, input.database)) as Record<string, unknown>[];
      label = 'query-result';
    } else {
      if (!input.table) throw new BadRequestException('整表导出必须选择数据表');
      label = input.table;
      rows = [];
      for (let offset = 0; ; offset += 1000) {
        const batch = await this.readBatch(type, config, input.database, input.table, offset, 1000);
        rows.push(...batch);
        if (rows.length > 100_000) throw new BadRequestException('单次导出最多 100000 行，请通过查询条件分批导出');
        if (batch.length < 1000) break;
      }
    }
    const normalizedRows = rows.map(normalizeSpreadsheetRow);
    const estimatedBytes = Buffer.byteLength(JSON.stringify(normalizedRows, (_key, value) => typeof value === 'bigint' ? String(value) : value), 'utf8');
    if (estimatedBytes > this.maxExportBytes) throw new BadRequestException(`导出内容超过 ${Math.floor(this.maxExportBytes / 1024 / 1024)} MiB，请缩小查询范围或分批导出`);
    const columns = Array.from(new Set(normalizedRows.flatMap((row) => Object.keys(row))));
    let buffer: Buffer;
    if (format === 'xlsx') {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('data');
      sheet.columns = columns.map((column) => ({ header: column, key: column }));
      sheet.addRows(normalizedRows);
      buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    } else {
      const lines = [columns.map(csvCell).join(','), ...normalizedRows.map((row) => columns.map((column) => csvCell(row[column])).join(','))];
      buffer = Buffer.from('\uFEFF' + lines.join('\r\n'), 'utf8');
    }
    return {
      buffer,
      filename: `${safeFilename(label)}-${new Date().toISOString().replace(/[:.]/g, '-')}.${format}`,
      contentType: format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv; charset=utf-8',
      rows: rows.length,
    };
  }

  async importData(datasourceId: string, userId: string, input: { database: string; table: string }, file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('请选择 CSV 或 Excel 文件');
    if (!/\.(csv|xlsx)$/i.test(file.originalname)) throw new BadRequestException('仅支持 .csv、.xlsx 文件');
    const { type, config } = await this.getDatasourceConfig(datasourceId, userId);
    if (!['mysql', 'postgresql'].includes(type)) throw new BadRequestException('仅关系型数据库支持文件导入');
    let rows: Record<string, unknown>[];
    if (file.originalname.toLowerCase().endsWith('.csv')) {
      if (!['text/csv', 'application/csv', 'text/plain', 'application/octet-stream'].includes(file.mimetype)) throw new BadRequestException('CSV 文件 Content-Type 与扩展名不一致');
      if (file.buffer.includes(0)) throw new BadRequestException('CSV 文件包含不支持的空字符');
      try { new TextDecoder('utf-8', { fatal: true }).decode(file.buffer); } catch { throw new BadRequestException('CSV 文件必须使用 UTF-8 编码'); }
      let matrix: unknown[][];
      try { matrix = parseCsv(file.buffer, { columns: false, skip_empty_lines: true, bom: true, relax_column_count: false, trim: false, max_record_size: 1024 * 1024 }) as unknown[][]; }
      catch { throw new BadRequestException('CSV 文件格式非法、列数不一致或单行超过 1 MiB'); }
      const headers = validateImportHeaders(matrix.shift() || []);
      rows = matrix.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? null])));
    } else {
      if (!['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip', 'application/octet-stream'].includes(file.mimetype)) throw new BadRequestException('XLSX 文件 Content-Type 与扩展名不一致');
      if (file.buffer.length < 4 || file.buffer[0] !== 0x50 || file.buffer[1] !== 0x4b || file.buffer[2] !== 0x03 || file.buffer[3] !== 0x04) throw new BadRequestException('XLSX 文件签名非法');
      validateXlsxArchive(file.buffer);
      const workbook = new ExcelJS.Workbook();
      try { await workbook.xlsx.load(file.buffer as any); } catch { throw new BadRequestException('XLSX 文件损坏或内容无法解析'); }
      if (workbook.worksheets.length > 10) throw new BadRequestException('Excel 文件最多允许 10 个工作表');
      const sheet = workbook.worksheets[0];
      if (!sheet) throw new BadRequestException('文件中没有可读取的工作表');
      if (sheet.actualColumnCount > 200 || sheet.actualRowCount > 5001) throw new BadRequestException('Excel 文件最多允许 200 列、5000 行数据');
      const headers = validateImportHeaders((sheet.getRow(1).values as unknown[]).slice(1).map(excelCellValue));
      rows = [];
      sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const record: Record<string, unknown> = {};
        headers.forEach((header, index) => { record[header] = excelCellValue(row.getCell(index + 1).value); });
        if (Object.values(record).some((value) => value != null && value !== '')) rows.push(record);
      });
    }
    if (!rows.length) throw new BadRequestException('文件中没有数据行');
    if (rows.length > 5000) throw new BadRequestException('单次导入最多 5000 行，请拆分文件后重试');
    validateImportCells(rows);
    const columns = Object.keys(rows[0]);
    if (!columns.length || columns.some((column) => !safeIdentifier(column))) throw new BadRequestException('首行必须是合法的数据库字段名');
    if (rows.some((row) => Object.keys(row).some((column) => !columns.includes(column)))) throw new BadRequestException('文件各行字段必须一致');
    const targetColumns = await this.readColumns(type, config, input.database, input.table);
    if (!targetColumns.length) throw new BadRequestException('目标表不存在或无法读取表结构');
    const targetNames = new Set(targetColumns.map((column) => column.name));
    const unknownColumns = columns.filter((column) => !targetNames.has(column));
    if (unknownColumns.length) throw new BadRequestException(`文件字段与目标表不匹配: ${unknownColumns.join(', ')}`);
    const values = rows.map((row) => `(${columns.map((column) => sqlLiteral(row[column], type)).join(',')})`).join(',');
    const sql = `INSERT INTO ${quoteIdentifier(type, input.table)} (${columns.map((column) => quoteIdentifier(type, column)).join(',')}) VALUES ${values}`;
    if (Buffer.byteLength(sql, 'utf8') > 5 * 1024 * 1024) throw new BadRequestException('导入内容超过 5MB SQL 安全限制，请拆分文件');
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('用户不存在');
    const approval = await this.prisma.databaseApproval.create({ data: {
      datasourceId, requesterId: userId, requesterName: user.displayName || user.username,
      database: input.database, sql, operation: `import_${file.originalname.toLowerCase().endsWith('.csv') ? 'csv' : 'excel'}`,
    } });
    return { approvalRequired: true, approvalId: approval.id, status: approval.status, rows: rows.length, columns, filename: file.originalname };
  }

  async listApprovals(userId: string, admin: boolean, query: ApprovalListQueryDto) {
    const where: Prisma.DatabaseApprovalWhereInput = { ...(admin ? { datasource: { approvers: { some: { id: userId } } } } : { requesterId: userId }), ...(query.status ? { status: query.status } : {}) };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.databaseApproval.findMany({
      where,
      ...pageArgs(query),
      include: { datasource: { select: { id: true, name: true, type: true, approvers: { select: { id: true, username: true, displayName: true } } } } },
      orderBy: { requestedAt: 'desc' },
    }),
      this.prisma.databaseApproval.count({ where }),
    ]);
    return pageResult(items, total, query);
  }

  async analyzeApproval(id: string, userId: string, refresh = false) {
    const approval = await this.prisma.databaseApproval.findUnique({ where: { id }, include: { datasource: { select: { id: true, type: true } } } });
    if (!approval) throw new NotFoundException({ code: 'DB_APPROVAL_NOT_FOUND', message: '审批单不存在' });
    await this.assertDatasourceApprover(approval.datasourceId, userId);
    if (approval.planAnalysis && (!refresh || approval.status !== 'pending')) {
      return { ...(approval.planAnalysis as Record<string, unknown>), analyzedAt: approval.analyzedAt, cached: true };
    }
    const operation = approval.operation.toLowerCase();
    if (!['select', 'update', 'delete', 'insert'].includes(operation) || (operation === 'insert' && !/\bselect\b/i.test(approval.sql))) {
      return this.savePlanAnalysis(id, { available: false, reason: `${operation.toUpperCase()} 不支持安全执行 EXPLAIN`, warnings: approval.sql.length > 100_000 ? ['SQL 内容较大，审批前请重点核对导入行数和目标字段'] : [] });
    }
    const { type, config } = await this.getDatasourceConfig(approval.datasourceId, approval.requesterId);
    try {
      if (type === 'mysql') {
        const rows = records(await this.queryMySQL({ ...config, database: approval.database ?? config.database }, `EXPLAIN ${approval.sql}`));
        const steps = rows.map((row) => ({ table: nullableText(row.table), accessType: nullableText(row.type), possibleKeys: splitKeys(row.possible_keys), usedKey: nullableText(row.key), estimatedRows: finiteNumber(row.rows), filteredPercent: row.filtered == null ? null : finiteNumber(row.filtered), extra: nullableText(row.Extra) }));
        return this.savePlanAnalysis(id, { available: true, engine: 'mysql', estimatedRows: steps.reduce((sum, step) => sum + step.estimatedRows, 0), usedIndexes: [...new Set(steps.map((step) => step.usedKey).filter(Boolean))], steps, warnings: mysqlPlanWarnings(steps) });
      }
      if (type === 'postgresql') {
        const rows = records(await this.queryPostgreSQL(config, `EXPLAIN (FORMAT JSON, COSTS TRUE, VERBOSE FALSE) ${approval.sql}`, approval.database ?? undefined));
        const planList = Array.isArray(rows[0]?.['QUERY PLAN']) ? rows[0]['QUERY PLAN'] : [];
        const root = planList.length ? recordValue(planList[0]).Plan : undefined;
        if (!root) return this.savePlanAnalysis(id, { available: false, reason: 'PostgreSQL 未返回执行计划', warnings: [] });
        const steps = flattenPostgresPlan(root);
        const rootNode = recordValue(root);
        return this.savePlanAnalysis(id, { available: true, engine: 'postgresql', estimatedRows: finiteNumber(rootNode['Plan Rows']), totalCost: finiteNumber(rootNode['Total Cost']), usedIndexes: [...new Set(steps.map((step) => step.indexName).filter(Boolean))], steps, warnings: postgresPlanWarnings(steps) });
      }
      return this.savePlanAnalysis(id, { available: false, reason: '当前数据源类型不支持 SQL 执行计划', warnings: [] });
    } catch (error) {
      this.logger.warn(`执行计划分析失败 approval=${id}: ${errorMessage(error)}`);
      return this.savePlanAnalysis(id, { available: false, reason: '数据库未能生成安全执行计划，请联系管理员查看服务端日志', warnings: ['请人工核对 SQL 条件、影响范围和回滚方案'] });
    }
  }

  private async savePlanAnalysis(id: string, analysis: Record<string, unknown>) {
    const analyzedAt = new Date();
    await this.prisma.databaseApproval.update({ where: { id }, data: { planAnalysis: analysis as Prisma.InputJsonObject, analyzedAt } });
    return { ...analysis, analyzedAt, cached: false };
  }

  async approve(id: string, approverId: string) {
    const [approval, approver] = await Promise.all([
      this.prisma.databaseApproval.findUnique({ where: { id }, include: { datasource: true } }),
      this.prisma.user.findUnique({ where: { id: approverId } }),
    ]);
    if (!approval) throw new NotFoundException({ code: 'DB_APPROVAL_NOT_FOUND', message: '审批单不存在' });
    if (!approver) throw new NotFoundException({ code: 'APPROVER_NOT_FOUND', message: '审批人不存在' });
    await this.assertDatasourceApprover(approval.datasourceId, approverId);
    if (approval.requesterId === approverId) throw new ForbiddenException({ code: 'APPROVAL_SELF_REVIEW_FORBIDDEN', message: '申请人不能审批自己的数据库操作' });
    if (approval.status !== 'pending') throw new ConflictException({ code: 'APPROVAL_STATE_CONFLICT', message: `审批单当前状态为 ${approval.status}` });
    const claimed = await this.prisma.databaseApproval.updateMany({
      where: { id, status: 'pending' },
      data: { status: 'executing', approverId, approverName: approver.displayName || approver.username, reviewedAt: new Date() },
    });
    if (!claimed.count) throw new ConflictException({ code: 'APPROVAL_STATE_CONFLICT', message: '审批单已被其他审批人处理' });
    try {
      const { type, config } = await this.getDatasourceConfig(approval.datasourceId, approval.requesterId);
      const result = type === 'mysql'
        ? await this.queryMySQL(config, approval.sql)
        : type === 'postgresql'
          ? await this.queryPostgreSQL(config, approval.sql, approval.database ?? undefined)
          : (() => { throw new BadRequestException('仅关系型数据库支持 SQL 审批'); })();
      const summary = summarizeWriteResult(result);
      return await this.prisma.databaseApproval.update({
        where: { id },
        data: { status: 'approved', resultSummary: summary, executedAt: new Date() },
        include: { datasource: { select: { id: true, name: true, type: true } } },
      });
    } catch (error) {
      this.logger.error(`数据库审批执行失败 approval=${id}: ${errorMessage(error)}`);
      const publicError = error instanceof HttpException ? error.message : '数据库操作执行失败，请联系管理员查看服务端日志';
      await this.prisma.databaseApproval.update({ where: { id }, data: { status: 'failed', error: publicError, executedAt: new Date() } });
      if (error instanceof HttpException) throw error;
      throw new BadRequestException(publicError);
    }
  }

  async reject(id: string, approverId: string, reason: string) {
    if (!reason?.trim()) throw new BadRequestException('拒绝时必须填写原因');
    const [approval, approver] = await Promise.all([
      this.prisma.databaseApproval.findUnique({ where: { id } }),
      this.prisma.user.findUnique({ where: { id: approverId } }),
    ]);
    if (!approval) throw new NotFoundException({ code: 'DB_APPROVAL_NOT_FOUND', message: '审批单不存在' });
    if (!approver) throw new NotFoundException({ code: 'APPROVER_NOT_FOUND', message: '审批人不存在' });
    await this.assertDatasourceApprover(approval.datasourceId, approverId);
    const updated = await this.prisma.databaseApproval.updateMany({ where: { id, status: 'pending' }, data: { status: 'rejected', error: reason.trim(), approverId, approverName: approver.displayName || approver.username, reviewedAt: new Date() } });
    if (!updated.count) throw new ConflictException({ code: 'APPROVAL_STATE_CONFLICT', message: '审批单已被处理' });
    return { id, status: 'rejected' };
  }

  async createTransfer(userId: string, input: { kind?: string; sourceDatasourceId: string; targetDatasourceId?: string; sourceDatabase: string; targetDatabase?: string; tables: string[]; conflictStrategy?: string }) {
    const kind = input.kind === 'backup' || input.kind === 'native_backup' ? input.kind : 'migration';
    if (!input.sourceDatabase?.trim() || !Array.isArray(input.tables) || !input.tables.length) throw new BadRequestException('必须选择来源数据库和至少一张表');
    if (!safeIdentifier(input.sourceDatabase) || (input.targetDatabase && !safeIdentifier(input.targetDatabase))) throw new BadRequestException('数据库名包含不安全字符');
    if (input.tables.some((table) => !safeIdentifier(table))) throw new BadRequestException('表名包含不安全字符');
    if (kind === 'migration' && (!input.targetDatasourceId || !input.targetDatabase?.trim())) throw new BadRequestException('迁移必须选择目标数据源和目标数据库');
    if (input.sourceDatasourceId === input.targetDatasourceId && input.sourceDatabase === input.targetDatabase) throw new BadRequestException('来源和目标不能完全相同');
    const conflictStrategy = input.conflictStrategy ?? 'fail';
    if (!['fail', 'append', 'replace'].includes(conflictStrategy)) throw new BadRequestException('目标表冲突策略仅支持 fail、append 或 replace');
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: '用户不存在' });
    await this.getDatasourceConfig(input.sourceDatasourceId, userId);
    if (input.targetDatasourceId) await this.getDatasourceConfig(input.targetDatasourceId, userId);
    const preflight = kind === 'migration' ? await this.preflightTransfer(userId, { ...input, conflictStrategy }) : null;
    if (preflight?.blockers.length) throw new BadRequestException(`迁移预检查失败: ${preflight.blockers.join('；')}`);
    return this.prisma.databaseTransfer.create({
      data: {
        kind,
        sourceDatasourceId: input.sourceDatasourceId,
        targetDatasourceId: input.targetDatasourceId,
        requesterId: userId,
        requesterName: user.displayName || user.username,
        sourceDatabase: input.sourceDatabase,
        targetDatabase: input.targetDatabase,
        tables: input.tables,
        conflictStrategy,
        preflight: preflight as unknown as Prisma.InputJsonValue,
        checkpoints: {},
        totalTables: input.tables.length,
        status: kind === 'backup' || kind === 'native_backup' ? 'queued' : 'pending_approval',
      },
    });
  }

  async preflightTransfer(userId: string, input: { sourceDatasourceId: string; targetDatasourceId?: string; sourceDatabase: string; targetDatabase?: string; tables: string[]; conflictStrategy?: string }) {
    if (!input.targetDatasourceId || !input.targetDatabase) throw new BadRequestException('请选择目标数据源和数据库');
    if (!safeIdentifier(input.sourceDatabase) || !safeIdentifier(input.targetDatabase) || input.tables.some((table) => !safeIdentifier(table))) throw new BadRequestException('数据库名或表名包含不安全字符');
    const [source, target] = await Promise.all([this.getDatasourceConfig(input.sourceDatasourceId, userId), this.getDatasourceConfig(input.targetDatasourceId, userId)]);
    if (!['mysql', 'postgresql'].includes(source.type) || !['mysql', 'postgresql'].includes(target.type)) throw new BadRequestException('迁移仅支持 MySQL 和 PostgreSQL');
    const strategy = input.conflictStrategy ?? 'fail';
    const blockers: string[] = [];
    const warnings: string[] = [];
    const plans = [];
    for (const table of input.tables) {
      const columns = await this.readColumns(source.type, source.config, input.sourceDatabase, table);
      const exists = await this.targetTableExists(target.type, target.config, input.targetDatabase, table);
      if (!columns.length) blockers.push(`${table}: 来源表没有可迁移字段`);
      if (exists && strategy === 'fail') blockers.push(`${table}: 目标表已存在`);
      if (exists && strategy === 'replace') warnings.push(`${table}: 审批后将删除并重建目标表`);
      if (exists && strategy === 'append') {
        const targetColumns = await this.readColumns(target.type, target.config, input.targetDatabase, table);
        const missing = columns.filter((column) => !targetColumns.some((targetColumn) => targetColumn.name === column.name));
        if (missing.length) blockers.push(`${table}: 目标表缺少字段 ${missing.map((column) => column.name).join(', ')}`);
        warnings.push(`${table}: 将追加数据，调用方需确保主键不冲突`);
      }
      plans.push({ table, targetExists: exists, columns: columns.map((column) => ({ name: column.name, sourceType: column.type, targetType: mapColumnType(column.type, target.type) })) });
    }
    return { sourceType: source.type, targetType: target.type, strategy, blockers, warnings, tables: plans };
  }

  async listTransfers(userId: string, admin: boolean, query: PageQueryDto) {
    const where: Prisma.DatabaseTransferWhereInput = admin ? { OR: [
        { kind: 'migration', targetDatasource: { approvers: { some: { id: userId } } } },
        { kind: { not: 'migration' }, sourceDatasource: { approvers: { some: { id: userId } } } },
      ] } : { requesterId: userId };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.databaseTransfer.findMany({
      where,
      ...pageArgs(query),
      include: {
        sourceDatasource: { select: { id: true, name: true, type: true, approvers: { select: { id: true, username: true, displayName: true } } } },
        targetDatasource: { select: { id: true, name: true, type: true, approvers: { select: { id: true, username: true, displayName: true } } } },
      },
      orderBy: { requestedAt: 'desc' },
    }),
      this.prisma.databaseTransfer.count({ where }),
    ]);
    return pageResult(items, total, query);
  }

  async createNativeRestore(backupId: string, userId: string, input: { targetDatasourceId: string; targetDatabase: string }) {
    const [backup, user] = await Promise.all([
      this.prisma.databaseTransfer.findUnique({ where: { id: backupId } }),
      this.prisma.user.findUnique({ where: { id: userId } }),
    ]);
    if (!backup || backup.requesterId !== userId || backup.kind !== 'native_backup' || backup.status !== 'succeeded' || !backup.backupPath) throw new NotFoundException({ code: 'NATIVE_BACKUP_NOT_FOUND', message: '可恢复的原生备份不存在' });
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: '用户不存在' });
    if (!safeIdentifier(input.targetDatabase)) throw new BadRequestException('目标数据库名不安全');
    const target = await this.getDatasourceConfig(input.targetDatasourceId, userId);
    const manifest = await this.verifyNativeBackup(backup.backupPath);
    if (target.type !== manifest.engine) throw new BadRequestException(`原生恢复不支持跨类型：备份为 ${manifest.engine}，目标为 ${target.type}`);
    const existingTables = await this.listTables(input.targetDatasourceId, userId, input.targetDatabase);
    if (existingTables.length) throw new ConflictException({ code: 'RESTORE_TARGET_NOT_EMPTY', message: '目标数据库不是空库；为防止覆盖数据，原生恢复仅允许恢复到空数据库' });
    return this.prisma.databaseTransfer.create({ data: {
      kind: 'native_restore', sourceDatasourceId: input.targetDatasourceId, requesterId: userId,
      requesterName: user.displayName || user.username, sourceDatabase: input.targetDatabase,
      tables: manifest.tables, totalTables: manifest.tables.length, backupPath: backup.backupPath,
      preflight: { backupId, engine: manifest.engine, format: manifest.format, sha256: manifest.sha256, targetEmpty: true },
      checkpoints: {}, status: 'pending_approval',
    } });
  }

  async approveTransfer(id: string, approverId: string) {
    const [row, approver] = await Promise.all([this.prisma.databaseTransfer.findUnique({ where: { id } }), this.prisma.user.findUnique({ where: { id: approverId } })]);
    if (!row) throw new NotFoundException({ code: 'DB_TRANSFER_NOT_FOUND', message: '数据库传输任务不存在' });
    if (!approver) throw new NotFoundException({ code: 'APPROVER_NOT_FOUND', message: '审批人不存在' });
    await this.assertDatasourceApprover(row.kind === 'migration' && row.targetDatasourceId ? row.targetDatasourceId : row.sourceDatasourceId, approverId);
    if (row.requesterId === approverId) throw new ForbiddenException({ code: 'APPROVAL_SELF_REVIEW_FORBIDDEN', message: '申请人不能审批自己的数据库传输任务' });
    const updated = await this.prisma.databaseTransfer.updateMany({ where: { id, status: 'pending_approval' }, data: { status: 'queued', approverId, approverName: approver.displayName || approver.username, reviewedAt: new Date() } });
    if (!updated.count) throw new ConflictException({ code: 'DB_TRANSFER_STATE_CONFLICT', message: '数据库传输任务已被处理' });
    return { id, status: 'queued' };
  }

  async rejectTransfer(id: string, approverId: string, reason: string) {
    if (!reason?.trim()) throw new BadRequestException('拒绝原因不能为空');
    const row = await this.prisma.databaseTransfer.findUnique({ where: { id } });
    if (!row) throw new NotFoundException({ code: 'DB_TRANSFER_NOT_FOUND', message: '数据库传输任务不存在' });
    await this.assertDatasourceApprover(row.kind === 'migration' && row.targetDatasourceId ? row.targetDatasourceId : row.sourceDatasourceId, approverId);
    const approver = await this.prisma.user.findUnique({ where: { id: approverId } });
    const updated = await this.prisma.databaseTransfer.updateMany({ where: { id, status: 'pending_approval' }, data: { status: 'rejected', error: reason.trim(), approverId, approverName: approver?.displayName || approver?.username, reviewedAt: new Date(), finishedAt: new Date() } });
    if (!updated.count) throw new ConflictException({ code: 'DB_TRANSFER_STATE_CONFLICT', message: '数据库传输任务已被处理' });
    return { id, status: 'rejected' };
  }

  async cancelTransfer(id: string, userId: string, admin: boolean) {
    const row = await this.prisma.databaseTransfer.findUnique({ where: { id } });
    if (!row || (!admin && row.requesterId !== userId)) throw new NotFoundException({ code: 'DB_TRANSFER_NOT_FOUND', message: '数据库传输任务不存在' });
    if (!['pending_approval', 'queued', 'running'].includes(row.status)) throw new ConflictException({ code: 'DB_TRANSFER_FINISHED', message: '数据库传输任务已经结束' });
    if (row.status === 'running') {
      await this.prisma.databaseTransfer.update({ where: { id }, data: { cancelRequested: true } });
      return { id, status: 'cancelling' };
    }
    await this.prisma.databaseTransfer.update({ where: { id }, data: { status: 'cancelled', cancelRequested: true, finishedAt: new Date() } });
    return { id, status: 'cancelled' };
  }

  async retryTransfer(id: string, userId: string, admin: boolean, strategy?: string) {
    const row = await this.prisma.databaseTransfer.findUnique({ where: { id } });
    if (!row || (!admin && row.requesterId !== userId)) throw new NotFoundException({ code: 'DB_TRANSFER_NOT_FOUND', message: '数据库传输任务不存在' });
    if (!['failed', 'cancelled'].includes(row.status)) throw new ConflictException({ code: 'DB_TRANSFER_RETRY_NOT_ALLOWED', message: '只有失败或取消的任务可以重试' });
    const nextStrategy = strategy ?? row.conflictStrategy;
    if (row.kind === 'migration' && row.migratedRows > 0 && nextStrategy !== 'replace') throw new ConflictException({ code: 'DB_TRANSFER_RETRY_REQUIRES_REPLACE', message: '目标库已写入部分数据，重试必须选择 replace 以避免重复数据' });
    return this.prisma.databaseTransfer.update({ where: { id }, data: { status: row.kind === 'backup' || row.kind === 'native_backup' ? 'queued' : 'pending_approval', conflictStrategy: nextStrategy, checkpoints: {}, completedTables: 0, totalRows: 0, migratedRows: 0, currentTable: null, cancelRequested: false, error: null, startedAt: null, finishedAt: null, heartbeatAt: null, leaseOwner: null } });
  }

  async dispatchTransfer() {
    await this.prisma.databaseTransfer.updateMany({ where: { status: 'running', heartbeatAt: { lt: new Date(Date.now() - 2 * 60_000) } }, data: { status: 'failed', error: '执行节点心跳超时，任务已安全停止；请检查目标数据后重试', finishedAt: new Date(), leaseOwner: null } }).catch(() => undefined);
    const candidate = await this.prisma.databaseTransfer.findFirst({ where: { status: 'queued' }, orderBy: { requestedAt: 'asc' } }).catch(() => null);
    if (!candidate) return;
    const leaseOwner = `${hostname()}:${process.pid}`;
    const claimed = await this.prisma.databaseTransfer.updateMany({ where: { id: candidate.id, status: 'queued' }, data: { status: 'running', startedAt: new Date(), error: null, leaseOwner, heartbeatAt: new Date() } });
    if (!claimed.count) return;
    try {
      await this.runTransfer(candidate.id);
      await this.prisma.databaseTransfer.update({ where: { id: candidate.id }, data: { status: 'succeeded', currentTable: null, finishedAt: new Date(), leaseOwner: null, heartbeatAt: new Date() } });
    } catch (error) {
      this.logger.error(`数据库传输失败 id=${candidate.id}: ${errorMessage(error)}`);
      const cancelled = error instanceof Error && error.name === 'TransferCancelledError';
      const publicError = cancelled ? '任务已由用户取消' : error instanceof HttpException ? error.message : '数据库传输执行失败，请联系管理员查看服务端日志';
      await this.prisma.databaseTransfer.update({ where: { id: candidate.id }, data: { status: cancelled ? 'cancelled' : 'failed', error: publicError, finishedAt: new Date(), leaseOwner: null, heartbeatAt: new Date() } }).catch(() => undefined);
    }
  }

  private async runTransfer(id: string) {
    const task = await this.prisma.databaseTransfer.findUnique({ where: { id } });
    if (!task) throw new Error('迁移任务不存在');
    const source = await this.getDatasourceConfig(task.sourceDatasourceId, task.requesterId);
    const target = task.targetDatasourceId ? await this.getDatasourceConfig(task.targetDatasourceId, task.requesterId) : null;
    const backupRoot = resolve(this.configService.get('DATABASE_BACKUP_DIR', '.data/backups/databases'));
    const taskDir = join(backupRoot, task.id);
    if (task.kind === 'native_backup') {
      await this.runNativeBackup(task.id, source.type, source.config, task.sourceDatabase, task.tables, taskDir);
      return;
    }
    if (task.kind === 'native_restore') {
      if (!task.backupPath) throw new Error('恢复任务缺少备份文件');
      await this.runNativeRestore(task.id, source.type, source.config, task.sourceDatabase, task.backupPath, task.totalTables);
      return;
    }
    if (task.kind === 'backup') {
      await mkdir(taskDir, { recursive: true });
      await writeFile(join(taskDir, 'manifest.json'), JSON.stringify({ version: 1, format: 'jsonl-directory', sourceType: source.type, database: task.sourceDatabase, tables: task.tables, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    }
    for (const table of task.tables) {
      await this.ensureTransferActive(id);
      await this.prisma.databaseTransfer.update({ where: { id }, data: { currentTable: table } });
      const columns = await this.readColumns(source.type, source.config, task.sourceDatabase, table);
      if (target && task.targetDatabase) {
        const exists = await this.targetTableExists(target.type, target.config, task.targetDatabase, table);
        if (exists && task.conflictStrategy === 'fail') throw new Error(`目标表 ${table} 已存在`);
        if (exists && task.conflictStrategy === 'replace') await this.dropTargetTable(target.type, target.config, task.targetDatabase, table);
        await this.ensureTargetTable(target.type, target.config, task.targetDatabase, table, columns);
      }
      let offset = 0;
      if (task.kind === 'backup') await writeFile(join(taskDir, `${table}.jsonl`), '', { mode: 0o600 });
      while (true) {
        await this.ensureTransferActive(id);
        const rows = await this.readBatch(source.type, source.config, task.sourceDatabase, table, offset, 500);
        if (!rows.length) break;
        if (task.kind === 'backup') await appendFile(join(taskDir, `${table}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
        else if (target && task.targetDatabase) await this.insertBatch(target.type, target.config, task.targetDatabase, table, columns.map((column) => column.name), rows);
        offset += rows.length;
        await this.prisma.databaseTransfer.update({ where: { id }, data: { migratedRows: { increment: rows.length }, totalRows: { increment: rows.length }, heartbeatAt: new Date() } });
        await this.updateCheckpoint(id, table, 'running', offset);
        if (rows.length < 500) break;
      }
      await this.updateCheckpoint(id, table, 'succeeded', offset);
      await this.prisma.databaseTransfer.update({ where: { id }, data: { completedTables: { increment: 1 }, heartbeatAt: new Date(), ...(task.kind === 'backup' ? { backupPath: taskDir } : {}) } });
    }
  }

  private async runNativeBackup(id: string, type: string, config: DatasourceConfig, database: string, tables: string[], taskDir: string) {
    if (!['mysql', 'postgresql'].includes(type)) throw new BadRequestException('原生备份仅支持 MySQL 和 PostgreSQL');
    await mkdir(taskDir, { recursive: true });
    const filename = type === 'postgresql' ? `${safeFilename(database)}.dump` : `${safeFilename(database)}.sql`;
    const outputPath = join(taskDir, filename);
    const args = type === 'postgresql'
      ? ['--format=custom', '--no-owner', '--no-privileges', '--file', outputPath, '--host', config.host, '--port', String(config.port), '--username', config.username || '', ...tables.flatMap((table) => ['--table', table]), database]
      : ['--single-transaction', '--quick', '--routines', '--triggers', '--events', '--result-file', outputPath, '--host', config.host, '--port', String(config.port), '--user', config.username || '', database, ...tables];
    const command = type === 'postgresql' ? 'pg_dump' : 'mariadb-dump';
    await this.runBackupCommand(id, command, args, { ...(process.env as Record<string, string>), ...(type === 'postgresql' ? { PGPASSWORD: config.password || '' } : { MYSQL_PWD: config.password || '' }) }, outputPath);
    await this.ensureTransferActive(id);
    const metadata = await stat(outputPath);
    const manifest = {
      version: 1, format: type === 'postgresql' ? 'postgresql-custom' : 'mysql-sql', engine: type,
      database, tables, filename, size: metadata.size, sha256: await sha256File(outputPath), createdAt: new Date().toISOString(),
    };
    await writeFile(join(taskDir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    await this.prisma.databaseTransfer.update({ where: { id }, data: { backupPath: outputPath, completedTables: tables.length, checkpoints: manifest as unknown as Prisma.InputJsonValue, heartbeatAt: new Date() } });
  }

  private runBackupCommand(id: string, command: string, args: string[], env: NodeJS.ProcessEnv, outputPath?: string): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(command, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      let oversized = false;
      child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-16_000); });
      const timer = setInterval(async () => {
        await this.prisma.databaseTransfer.update({ where: { id }, data: { heartbeatAt: new Date() } }).catch(() => undefined);
        if (outputPath) { const metadata = await stat(outputPath).catch(() => null); if (metadata && metadata.size > this.maxBackupBytes) { oversized = true; child.kill('SIGTERM'); } }
        const row = await this.prisma.databaseTransfer.findUnique({ where: { id }, select: { cancelRequested: true } }).catch(() => null);
        if (row?.cancelRequested) child.kill('SIGTERM');
      }, 2000);
      timer.unref();
      child.once('error', (error) => { clearInterval(timer); rejectPromise(new Error(`${command} 无法启动，请确认运行镜像已安装数据库客户端: ${error.message}`)); });
      child.once('close', async (code, signal) => {
        clearInterval(timer);
        if (oversized) { if (outputPath) await unlink(outputPath).catch(() => undefined); rejectPromise(new Error(`备份文件超过 ${Math.floor(this.maxBackupBytes / 1024 / 1024)} MiB 限制，已终止并清理临时文件`)); return; }
        const row = await this.prisma.databaseTransfer.findUnique({ where: { id }, select: { cancelRequested: true } }).catch(() => null);
        if (row?.cancelRequested) { const error = new Error('原生备份已取消'); error.name = 'TransferCancelledError'; rejectPromise(error); return; }
        if (code !== 0) rejectPromise(new Error(`${command} 执行失败 (${signal || code}): ${redactDiagnosticText(stderr || '无错误输出', [env.PGPASSWORD, env.MYSQL_PWD])}`));
        else resolvePromise();
      });
    });
  }

  private async verifyNativeBackup(backupPath: string): Promise<NativeBackupManifest> {
    const backupRoot = resolve(this.configService.get('DATABASE_BACKUP_DIR', '.data/backups/databases'));
    let rootPath: string;
    let path: string;
    try {
      [rootPath, path] = await Promise.all([realpath(backupRoot), realpath(resolve(backupPath))]);
    } catch {
      throw new ConflictException({ code: 'BACKUP_FILE_MISSING', message: '备份文件不存在或已被移除' });
    }
    if (!isContainedPath(rootPath, path)) throw new ForbiddenException({ code: 'BACKUP_PATH_INVALID', message: '备份路径越界' });
    const fileMetadata = await stat(path).catch(() => {
      throw new ConflictException({ code: 'BACKUP_FILE_MISSING', message: '备份文件不存在或已被移除' });
    });
    if (!fileMetadata.isFile()) throw new ConflictException({ code: 'BACKUP_FILE_INVALID', message: '原生备份路径不是普通文件' });
    if (fileMetadata.size > this.maxBackupBytes) throw new ConflictException({ code: 'BACKUP_FILE_TOO_LARGE', message: '原生备份文件超过平台恢复大小限制' });
    let manifestPath: string;
    try {
      manifestPath = await realpath(join(dirname(path), 'manifest.json'));
    } catch {
      throw new ConflictException({ code: 'BACKUP_MANIFEST_MISSING', message: '备份 manifest 不存在或已被移除' });
    }
    if (dirname(manifestPath) !== dirname(path) || !isContainedPath(rootPath, manifestPath)) throw new ForbiddenException({ code: 'BACKUP_MANIFEST_PATH_INVALID', message: '备份 manifest 路径越界' });
    const manifestMetadata = await stat(manifestPath).catch(() => {
      throw new ConflictException({ code: 'BACKUP_MANIFEST_MISSING', message: '备份 manifest 不存在或已被移除' });
    });
    if (!manifestMetadata.isFile() || manifestMetadata.size > 64 * 1024) throw new ConflictException({ code: 'BACKUP_MANIFEST_INVALID', message: '备份 manifest 非法或超过 64 KiB' });
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(manifestPath, 'utf8')); } catch { throw new ConflictException({ code: 'BACKUP_MANIFEST_INVALID', message: '备份 manifest 不是合法 JSON' }); }
    const manifest = parseNativeBackupManifest(parsed);
    if (manifest.filename !== basename(path) || manifest.size !== fileMetadata.size) throw new ConflictException({ code: 'BACKUP_INTEGRITY_FAILED', message: '备份文件名或大小与 manifest 不一致' });
    const actual = await sha256File(path).catch(() => {
      throw new ConflictException({ code: 'BACKUP_FILE_MISSING', message: '备份文件在校验期间不可读取' });
    });
    if (actual !== manifest.sha256) throw new ConflictException({ code: 'BACKUP_INTEGRITY_FAILED', message: '备份 SHA-256 校验失败，禁止恢复' });
    return manifest;
  }

  private async runNativeRestore(id: string, type: string, config: DatasourceConfig, database: string, backupPath: string, totalTables: number) {
    const manifest = await this.verifyNativeBackup(backupPath);
    if (manifest.engine !== type) throw new Error('备份引擎与目标数据源类型不一致');
    const existingTables = type === 'mysql'
      ? records(await this.queryMySQL({ ...config, database }, 'SHOW TABLES'))
      : records(await this.queryPostgreSQL(config, "SELECT tablename FROM pg_tables WHERE schemaname='public'", database));
    if (existingTables.length) throw new Error('审批后目标数据库已出现数据表，恢复已安全终止');
    await this.ensureTransferActive(id);
    if (type === 'postgresql') {
      await this.runBackupCommand(id, 'pg_restore', ['--exit-on-error', '--no-owner', '--no-privileges', '--host', config.host, '--port', String(config.port), '--username', config.username || '', '--dbname', database, backupPath], { ...process.env, PGPASSWORD: config.password || '' });
    } else {
      await this.runMysqlRestoreCommand(id, config, database, backupPath);
    }
    await this.prisma.databaseTransfer.update({ where: { id }, data: { completedTables: totalTables, heartbeatAt: new Date(), checkpoints: { restored: true, verifiedSha256: manifest.sha256 } } });
  }

  private runMysqlRestoreCommand(id: string, config: DatasourceConfig, database: string, backupPath: string): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn('mariadb', ['--host', config.host, '--port', String(config.port), '--user', config.username || '', database], { env: { ...process.env, MYSQL_PWD: config.password || '' }, stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-16_000); });
      const input = createReadStream(backupPath); input.on('error', () => child.kill('SIGTERM')); input.pipe(child.stdin);
      const timer = setInterval(async () => { await this.prisma.databaseTransfer.update({ where: { id }, data: { heartbeatAt: new Date() } }).catch(() => undefined); const row = await this.prisma.databaseTransfer.findUnique({ where: { id }, select: { cancelRequested: true } }).catch(() => null); if (row?.cancelRequested) child.kill('SIGTERM'); }, 2000); timer.unref();
      child.once('error', (error) => { clearInterval(timer); rejectPromise(new Error(`mariadb 无法启动: ${error.message}`)); });
      child.once('close', async (code) => { clearInterval(timer); const row = await this.prisma.databaseTransfer.findUnique({ where: { id }, select: { cancelRequested: true } }).catch(() => null); if (row?.cancelRequested) { const error = new Error('原生恢复已取消'); error.name = 'TransferCancelledError'; rejectPromise(error); return; } if (code !== 0) rejectPromise(new Error(`mariadb 恢复失败 (${code}): ${redactDiagnosticText(stderr || '无错误输出', [config.password])}`)); else resolvePromise(); });
    });
  }

  async readBackupFile(id: string, userId: string, admin: boolean) {
    const task = await this.prisma.databaseTransfer.findUnique({ where: { id } });
    if (!task || (!admin && task.requesterId !== userId)) throw new NotFoundException({ code: 'BACKUP_TASK_NOT_FOUND', message: '备份任务不存在' });
    if (!['backup', 'native_backup'].includes(task.kind) || task.status !== 'succeeded' || !task.backupPath) throw new ConflictException({ code: 'BACKUP_FILE_NOT_READY', message: '备份尚未生成可下载文件' });
    const backupRoot = resolve(this.configService.get('DATABASE_BACKUP_DIR', '.data/backups/databases'));
    let rootPath: string;
    let path: string;
    try {
      [rootPath, path] = await Promise.all([realpath(backupRoot), realpath(resolve(task.backupPath))]);
    } catch {
      throw new ConflictException({ code: 'BACKUP_FILE_MISSING', message: '备份文件不存在或已被移除' });
    }
    if (!isContainedPath(rootPath, path)) throw new ForbiddenException({ code: 'BACKUP_PATH_INVALID', message: '备份路径越界' });
    const metadata = await stat(path).catch(() => {
      throw new ConflictException({ code: 'BACKUP_FILE_MISSING', message: '备份文件不存在或已被移除' });
    });
    if (!metadata.isFile()) throw new ConflictException({ code: 'BACKUP_DOWNLOAD_UNSUPPORTED', message: '逻辑备份由多个文件组成，暂不支持单文件下载' });
    return { path, filename: path.split('/').pop() || 'database-backup', size: metadata.size };
  }

  private async ensureTransferActive(id: string) {
    const row = await this.prisma.databaseTransfer.findUnique({ where: { id }, select: { cancelRequested: true, status: true } });
    if (!row || row.cancelRequested || row.status !== 'running') { const error = new Error('迁移任务已取消'); error.name = 'TransferCancelledError'; throw error; }
  }

  private async assertDatasourceApprover(datasourceId: string, userId: string) {
    const datasource = await this.prisma.datasource.findFirst({ where: { id: datasourceId, approvers: { some: { id: userId } } }, select: { id: true } });
    if (!datasource) throw new ForbiddenException({ code: 'DATASOURCE_APPROVER_REQUIRED', message: '你不在该数据源的审批人列表中' });
  }

  private async updateCheckpoint(id: string, table: string, status: string, processedRows: number) {
    const row = await this.prisma.databaseTransfer.findUnique({ where: { id }, select: { checkpoints: true } });
    const checkpoints = row?.checkpoints && typeof row.checkpoints === 'object' && !Array.isArray(row.checkpoints) ? row.checkpoints as Record<string, unknown> : {};
    const next = { ...checkpoints, [table]: { status, processedRows } } as Prisma.InputJsonValue;
    await this.prisma.databaseTransfer.update({ where: { id }, data: { checkpoints: next } });
  }

  private async readColumns(type: string, config: DatasourceConfig, database: string, table: string): Promise<TransferColumn[]> {
    if (!safeIdentifier(database) || !safeIdentifier(table)) throw new BadRequestException('数据库名或表名包含不安全字符');
    if (type === 'mysql') {
      const rows = records(await this.queryMySQL({ ...config, database }, `SELECT COLUMN_NAME AS name, DATA_TYPE AS type, IS_NULLABLE AS nullable FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=${sqlLiteral(database, 'mysql')} AND TABLE_NAME=${sqlLiteral(table, 'mysql')} ORDER BY ORDINAL_POSITION`));
      return rows.map((row) => ({ name: textField(row, 'name'), type: textField(row, 'type'), nullable: row.nullable === 'YES' })).filter((column) => safeIdentifier(column.name) && !!column.type);
    }
    if (type === 'postgresql') {
      const rows = records(await this.queryPostgreSQL(config, `SELECT column_name AS name, data_type AS type, is_nullable AS nullable FROM information_schema.columns WHERE table_schema='public' AND table_name=${postgresLiteral(table)} ORDER BY ordinal_position`, database));
      return rows.map((row) => ({ name: textField(row, 'name'), type: textField(row, 'type'), nullable: row.nullable === 'YES' })).filter((column) => safeIdentifier(column.name) && !!column.type);
    }
    throw new BadRequestException('备份迁移仅支持 MySQL 和 PostgreSQL');
  }

  private async readBatch(type: string, config: DatasourceConfig, database: string, table: string, offset: number, limit: number): Promise<Record<string, unknown>[]> {
    const sql = `SELECT * FROM ${quoteIdentifier(type, table)} LIMIT ${limit} OFFSET ${offset}`;
    return type === 'mysql'
      ? await this.queryMySQL({ ...config, database }, sql) as Record<string, unknown>[]
      : await this.queryPostgreSQL(config, sql, database) as Record<string, unknown>[];
  }

  private async ensureTargetTable(type: string, config: DatasourceConfig, database: string, table: string, columns: TransferColumn[]) {
    if (!columns.length) throw new Error(`无法读取表 ${table} 的字段结构`);
    const definitions = columns.map((column) => `${quoteIdentifier(type, column.name)} ${mapColumnType(column.type, type)}${column.nullable ? '' : ' NOT NULL'}`).join(', ');
    const sql = `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(type, table)} (${definitions})`;
    if (type === 'mysql') await this.queryMySQL({ ...config, database }, sql);
    else if (type === 'postgresql') await this.queryPostgreSQL(config, sql, database);
    else throw new BadRequestException('目标仅支持 MySQL 和 PostgreSQL');
  }

  private async targetTableExists(type: string, config: DatasourceConfig, database: string, table: string) {
    if (!safeIdentifier(database) || !safeIdentifier(table)) throw new BadRequestException('数据库名或表名包含不安全字符');
    if (type === 'mysql') {
      const rows = records(await this.queryMySQL({ ...config, database }, `SELECT COUNT(*) AS count FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=${sqlLiteral(database, 'mysql')} AND TABLE_NAME=${sqlLiteral(table, 'mysql')}`));
      return finiteNumber(rows[0]?.count) > 0;
    }
    const rows = records(await this.queryPostgreSQL(config, `SELECT to_regclass(${postgresLiteral(`public.${table}`)}) IS NOT NULL AS exists`, database));
    return rows[0]?.exists === true;
  }

  private async dropTargetTable(type: string, config: DatasourceConfig, database: string, table: string) {
    const sql = `DROP TABLE ${quoteIdentifier(type, table)}`;
    if (type === 'mysql') await this.queryMySQL({ ...config, database }, sql);
    else await this.queryPostgreSQL(config, sql, database);
  }

  private async insertBatch(type: string, config: DatasourceConfig, database: string, table: string, columns: string[], rows: Record<string, unknown>[]) {
    if (!rows.length) return;
    if (type === 'mysql') {
      const connection = await createConnection({ host: config.host, port: config.port, user: config.username, password: config.password, database });
      try {
        const placeholders = rows.map(() => `(${columns.map(() => '?').join(',')})`).join(',');
        await connection.execute(`INSERT INTO ${quoteIdentifier(type, table)} (${columns.map((column) => quoteIdentifier(type, column)).join(',')}) VALUES ${placeholders}`, rows.flatMap((row) => columns.map((column) => normalizeTransferValue(row[column]))));
      } finally { await connection.end(); }
      return;
    }
    if (type === 'postgresql') {
      const pool = new Pool({ host: config.host, port: config.port, user: config.username, password: config.password, database });
      try {
        const values = rows.flatMap((row) => columns.map((column) => normalizeTransferValue(row[column])));
        let parameter = 0;
        const placeholders = rows.map(() => `(${columns.map(() => `$${++parameter}`).join(',')})`).join(',');
        await pool.query(`INSERT INTO ${quoteIdentifier(type, table)} (${columns.map((column) => quoteIdentifier(type, column)).join(',')}) VALUES ${placeholders}`, values);
      } finally { await pool.end(); }
      return;
    }
    throw new BadRequestException('目标仅支持 MySQL 和 PostgreSQL');
  }

  // 获取数据库列表（MySQL/PostgreSQL）
  async listDatabases(datasourceId: string, userId: string) {
    const { type, config } = await this.getDatasourceConfig(datasourceId, userId);

    try {
      if (type === 'mysql') {
        const result = await this.queryMySQL(config, 'SHOW DATABASES');
        return records(result).map((row) => textField(row, 'Database')).filter(Boolean);
      } else if (type === 'postgresql') {
        const result = await this.queryPostgreSQL(
          config,
          'SELECT datname FROM pg_database WHERE datistemplate = false',
        );
        return records(result).map((row) => textField(row, 'datname')).filter(Boolean);
      } else if (type === 'mongodb') {
        const uri = mongoUri(config);
        const client = new MongoClient(uri);
        try {
          await client.connect();
          const adminDb = client.db().admin();
          const result = await adminDb.listDatabases();
          return result.databases.map((db) => db.name);
        } finally {
          await client.close();
        }
      } else {
        throw new BadRequestException('该数据源类型不支持列出数据库');
      }
    } catch (error: unknown) {
      if (error instanceof HttpException) throw error;
      this.logger.warn(`获取数据库列表失败 datasource=${datasourceId} user=${userId}: ${errorMessage(error)}`);
      throw new BadRequestException('获取数据库列表失败，请检查连接状态或联系管理员');
    }
  }

  // 获取表列表
  async listTables(datasourceId: string, userId: string, database?: string) {
    const { type, config } = await this.getDatasourceConfig(datasourceId, userId);
    if (database && !safeDatabaseName(database)) throw new BadRequestException('数据库名格式非法');

    try {
      if (type === 'mysql') {
        const db = database || config.database;
        if (!db) throw new BadRequestException('请选择数据库');
        const result = await this.queryMySQL(config, `SHOW TABLES FROM ${quoteIdentifier(type, db)}`);
        return records(result).map((row) => Object.values(row)[0]).filter((value): value is string => typeof value === 'string');
      } else if (type === 'postgresql') {
        const result = await this.queryPostgreSQL(
          config,
          "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
          database,
        );
        return records(result).map((row) => textField(row, 'tablename')).filter(Boolean);
      } else if (type === 'mongodb') {
        if (!database) throw new BadRequestException('MongoDB 需要指定数据库名');
        const uri = mongoUri(config, database);
        const client = new MongoClient(uri);
        try {
          await client.connect();
          const db = client.db(database);
          const collections = await db.listCollections().toArray();
          return collections.map((coll) => coll.name);
        } finally {
          await client.close();
        }
      } else {
        throw new BadRequestException('该数据源类型不支持列出表');
      }
    } catch (error: unknown) {
      if (error instanceof HttpException) throw error;
      this.logger.warn(`获取表列表失败 datasource=${datasourceId} user=${userId}: ${errorMessage(error)}`);
      throw new BadRequestException('获取表列表失败，请检查连接状态或联系管理员');
    }
  }

  // 获取表结构
  async describeTable(
    datasourceId: string,
    userId: string,
    tableName: string,
    database?: string,
  ) {
    const { type, config } = await this.getDatasourceConfig(datasourceId, userId);
    if (!safeIdentifier(tableName)) throw new BadRequestException('表名格式非法');
    if (database && !safeDatabaseName(database)) throw new BadRequestException('数据库名格式非法');

    try {
      if (type === 'mysql') {
        const db = database || config.database;
        if (!db) throw new BadRequestException('请选择数据库');
        return await this.queryMySQL(config, `DESCRIBE ${quoteIdentifier(type, db)}.${quoteIdentifier(type, tableName)}`);
      } else if (type === 'postgresql') {
        const result = await this.queryPostgreSQL(
          config,
          `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = ${postgresLiteral(tableName)}
           ORDER BY ordinal_position`,
          database,
        );
        return result;
      } else if (type === 'mongodb') {
        // MongoDB 是无模式的，返回示例文档
        if (!database) throw new BadRequestException('MongoDB 需要指定数据库名');
        const sampleDoc = await this.queryMongoDB(
          config,
          database,
          tableName,
          'findOne',
          {},
        );
        return sampleDoc;
      } else {
        throw new BadRequestException('该数据源类型不支持查看表结构');
      }
    } catch (error: unknown) {
      if (error instanceof HttpException) throw error;
      this.logger.warn(`获取表结构失败 datasource=${datasourceId} user=${userId}: ${errorMessage(error)}`);
      throw new BadRequestException('获取表结构失败，请检查连接状态或联系管理员');
    }
  }
}

export function classifySql(sql: unknown) {
  if (typeof sql !== 'string' || !sql.trim()) throw new BadRequestException('SQL 不能为空');
  const normalized = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n\r]*/g, ' ').trim();
  const first = normalized.match(/^([a-z]+)/i)?.[1]?.toUpperCase() ?? 'UNKNOWN';
  const containsWrite = /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|REPLACE|GRANT|REVOKE|CALL|COPY|VACUUM|ANALYZE|REINDEX|CLUSTER|COMMENT|SET|LOCK|UNLOCK|DO|EXECUTE|PREPARE|DEALLOCATE|LOAD|HANDLER)\b/i.test(normalized)
    || /\bINTO\s+(?:OUTFILE|DUMPFILE)\b/i.test(normalized)
    || /\bFOR\s+(?:UPDATE|SHARE)\b/i.test(normalized)
    || /\bLOCK\s+IN\s+SHARE\s+MODE\b/i.test(normalized);
  const readOnly = !containsWrite && (['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN'].includes(first) || first === 'WITH');
  return { requiresApproval: !readOnly, operation: first.toLowerCase() };
}

const READ_ONLY_REDIS_COMMANDS = new Set([
  'GET', 'MGET', 'EXISTS', 'TYPE', 'TTL', 'PTTL', 'STRLEN',
  'SCAN', 'HSCAN', 'SSCAN', 'ZSCAN',
  'HGET', 'HMGET', 'HGETALL', 'HLEN', 'HEXISTS', 'HKEYS', 'HVALS',
  'LRANGE', 'LINDEX', 'LLEN',
  'SMEMBERS', 'SISMEMBER', 'SMISMEMBER', 'SCARD',
  'ZRANGE', 'ZREVRANGE', 'ZRANK', 'ZREVRANK', 'ZSCORE', 'ZMSCORE', 'ZCARD', 'ZCOUNT',
]);
const READ_ONLY_MONGO_OPERATIONS = new Set(['find', 'findOne', 'countDocuments']);

function boundedLimit(value: unknown, maximum: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : Math.min(100, maximum);
}

function summarizeWriteResult(result: unknown) {
  if (Array.isArray(result)) return { returnedRows: result.length };
  if (result && typeof result === 'object') {
    const value = result as Record<string, unknown>;
    return {
      affectedRows: value.affectedRows ?? value.rowCount ?? null,
      insertId: value.insertId != null ? String(value.insertId) : null,
      command: value.command ?? null,
    };
  }
  return { completed: true };
}

function safeIdentifier(value: string) { return /^[A-Za-z_][A-Za-z0-9_$-]{0,127}$/.test(value); }
function validateImportHeaders(values: unknown[]) { const headers = values.map((value) => String(value ?? '').trim()); if (!headers.length || headers.length > 200 || headers.some((header) => !safeIdentifier(header))) throw new BadRequestException('首行必须包含最多 200 个合法数据库字段名'); if (new Set(headers).size !== headers.length) throw new BadRequestException('首行包含重复字段名'); return headers; }
function validateImportCells(rows: Record<string, unknown>[]) { for (const row of rows) for (const value of Object.values(row)) { const normalized = value == null ? '' : value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : String(value); if (Buffer.byteLength(normalized, 'utf8') > 1024 * 1024) throw new BadRequestException('单个导入单元格不得超过 1 MiB'); } }
function validateXlsxArchive(buffer: Buffer) {
  const eocdSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const eocd = buffer.lastIndexOf(eocdSignature);
  if (eocd < 0 || eocd + 22 > buffer.length) throw new BadRequestException('XLSX ZIP 目录缺失');
  if (eocd + 22 + buffer.readUInt16LE(eocd + 20) !== buffer.length || buffer.readUInt16LE(eocd + 4) !== 0 || buffer.readUInt16LE(eocd + 6) !== 0) throw new BadRequestException('XLSX ZIP 尾部或分卷信息非法');
  const entries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new BadRequestException('不支持 ZIP64 XLSX 文件');
  if (entries < 1 || entries > 10_000 || centralOffset + centralSize > buffer.length) throw new BadRequestException('XLSX ZIP 目录范围非法');
  let offset = centralOffset; let uncompressedBytes = 0;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw new BadRequestException('XLSX ZIP 条目非法');
    const size = buffer.readUInt32LE(offset + 24);
    if (size === 0xffffffff) throw new BadRequestException('不支持 ZIP64 XLSX 条目');
    uncompressedBytes += size;
    if (uncompressedBytes > 50 * 1024 * 1024) throw new BadRequestException('XLSX 解压后内容不得超过 50 MiB');
    offset += 46 + buffer.readUInt16LE(offset + 28) + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
  if (offset > centralOffset + centralSize) throw new BadRequestException('XLSX ZIP 中央目录长度非法');
}
function isContainedPath(root: string, target: string) { const path = relative(root, target); return path !== '' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && path !== '..' && !isAbsolute(path); }
function parseNativeBackupManifest(value: unknown): NativeBackupManifest {
  const manifest = recordValue(value);
  const engine = manifest.engine;
  const format = manifest.format;
  const tables = Array.isArray(manifest.tables) ? manifest.tables : [];
  const createdAt = typeof manifest.createdAt === 'string' ? new Date(manifest.createdAt) : new Date(NaN);
  if (manifest.version !== 1 || !['mysql', 'postgresql'].includes(String(engine)) || !['mysql-sql', 'postgresql-custom'].includes(String(format))) throw new ConflictException({ code: 'BACKUP_MANIFEST_INVALID', message: '备份 manifest 版本、引擎或格式非法' });
  if ((engine === 'mysql' && format !== 'mysql-sql') || (engine === 'postgresql' && format !== 'postgresql-custom')) throw new ConflictException({ code: 'BACKUP_MANIFEST_INVALID', message: '备份 manifest 引擎与格式不匹配' });
  if (typeof manifest.database !== 'string' || !safeIdentifier(manifest.database) || !tables.length || tables.length > 200 || tables.some((table) => typeof table !== 'string' || !safeIdentifier(table))) throw new ConflictException({ code: 'BACKUP_MANIFEST_INVALID', message: '备份 manifest 数据库或表清单非法' });
  if (typeof manifest.filename !== 'string' || basename(manifest.filename) !== manifest.filename || manifest.filename.length > 255) throw new ConflictException({ code: 'BACKUP_MANIFEST_INVALID', message: '备份 manifest 文件名非法' });
  if (typeof manifest.size !== 'number' || !Number.isSafeInteger(manifest.size) || manifest.size < 0 || typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new ConflictException({ code: 'BACKUP_MANIFEST_INVALID', message: '备份 manifest 大小或 SHA-256 非法' });
  if (!Number.isFinite(createdAt.getTime()) || createdAt.getTime() > Date.now() + 5 * 60_000) throw new ConflictException({ code: 'BACKUP_MANIFEST_INVALID', message: '备份 manifest 创建时间非法' });
  return { version: 1, engine: engine as NativeBackupManifest['engine'], format: format as NativeBackupManifest['format'], database: manifest.database, tables: tables as string[], filename: manifest.filename, size: Number(manifest.size), sha256: manifest.sha256, createdAt: manifest.createdAt as string };
}
function safeDatabaseName(value: string) { return value.length <= 128 && !/[\0\r\n/?#@]/.test(value); }
function mongoUri(config: DatasourceConfig, database = '') { const credentials = config.username ? `${encodeURIComponent(config.username)}:${encodeURIComponent(config.password || '')}@` : ''; const path = database ? `/${encodeURIComponent(database)}` : '/'; const auth = config.username ? `?authSource=${encodeURIComponent(config.authSource || 'admin')}` : ''; return `mongodb://${credentials}${config.host}:${config.port}${path}${auth}`; }
function postgresLiteral(value: string) { return `'${value.replace(/'/g, "''")}'`; }
function records(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && !Array.isArray(row)) : []; }
function recordValue(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function nullableText(value: unknown): string | null { return typeof value === 'string' && value ? value.slice(0, 10_000) : null; }
function finiteNumber(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function textField(row: Record<string, unknown>, key: string) { return typeof row[key] === 'string' ? row[key] : ''; }
function errorMessage(error: unknown) { return diagnosticMessage(error); }
function quoteIdentifier(type: string, value: string) {
  if (!safeIdentifier(value)) throw new BadRequestException(`非法标识符: ${value}`);
  return type === 'mysql' ? `\`${value}\`` : `"${value}"`;
}
function mapColumnType(source: string, target: string) {
  const type = source.toLowerCase();
  if (target === 'postgresql') {
    if (/tinyint|smallint/.test(type)) return 'SMALLINT';
    if (/bigint/.test(type)) return 'BIGINT';
    if (/int|serial/.test(type)) return 'INTEGER';
    if (/decimal|numeric|money/.test(type)) return 'NUMERIC';
    if (/double|float|real/.test(type)) return 'DOUBLE PRECISION';
    if (/bool|bit/.test(type)) return 'BOOLEAN';
    if (/date$/.test(type)) return 'DATE';
    if (/time|datetime|timestamp/.test(type)) return 'TIMESTAMP';
    if (/blob|binary|bytea/.test(type)) return 'BYTEA';
    if (/json/.test(type)) return 'JSONB';
    return 'TEXT';
  }
  if (/smallint/.test(type)) return 'SMALLINT';
  if (/bigint/.test(type)) return 'BIGINT';
  if (/int|serial/.test(type)) return 'INT';
  if (/decimal|numeric|money/.test(type)) return 'DECIMAL(38,10)';
  if (/double|float|real/.test(type)) return 'DOUBLE';
  if (/bool|bit/.test(type)) return 'BOOLEAN';
  if (/date$/.test(type)) return 'DATE';
  if (/time|datetime|timestamp/.test(type)) return 'DATETIME';
  if (/blob|binary|bytea/.test(type)) return 'LONGBLOB';
  if (/json/.test(type)) return 'JSON';
  return 'LONGTEXT';
}
function normalizeTransferValue(value: unknown) {
  if (value != null && typeof value === 'object' && !Buffer.isBuffer(value) && !(value instanceof Date)) return JSON.stringify(value);
  return value as any;
}
function normalizeSpreadsheetRow(row: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
    value == null || typeof value !== 'object' || value instanceof Date ? value : Buffer.isBuffer(value) ? value.toString('base64') : JSON.stringify(value),
  ]));
}
function sqlLiteral(value: unknown, type: string): string {
  if (value == null || value === '') return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new BadRequestException('文件包含非有限数值');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  const text = value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (text.includes('\0')) throw new BadRequestException('文件包含不支持的空字符');
  const escaped = type === 'mysql' ? text.replace(/\\/g, '\\\\').replace(/'/g, "''") : text.replace(/'/g, "''");
  return `'${escaped}'`;
}
function safeFilename(value: string) { return value.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || 'data'; }
function csvCell(value: unknown) {
  const untrustedText = typeof value === 'string';
  let text = value == null ? '' : value instanceof Date ? value.toISOString() : String(value);
  if (untrustedText && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function excelCellValue(value: unknown): unknown {
  if (value == null || typeof value !== 'object' || value instanceof Date) return value;
  const cell = value as Record<string, unknown>;
  if ('result' in cell) return cell.result;
  if ('text' in cell) return cell.text;
  if ('richText' in cell && Array.isArray(cell.richText)) return cell.richText.map((part) => nullableText(recordValue(part).text) || '').join('');
  if ('hyperlink' in cell) return cell.text ?? cell.hyperlink;
  return JSON.stringify(value);
}
function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', rejectPromise);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolvePromise(hash.digest('hex')));
  });
}
function splitKeys(value: unknown): string[] { return typeof value === 'string' && value ? value.split(',').map((item) => item.trim()).filter(Boolean) : []; }
function mysqlPlanWarnings(steps: Array<{ accessType: string | null; usedKey: string | null; estimatedRows: number; extra: string | null }>) {
  const warnings: string[] = [];
  if (steps.some((step) => step.accessType === 'ALL')) warnings.push('执行计划包含全表扫描（ALL）');
  if (steps.some((step) => !step.usedKey && step.estimatedRows > 1000)) warnings.push('大范围扫描未使用索引');
  if (steps.some((step) => /Using temporary|Using filesort/i.test(step.extra || ''))) warnings.push('执行计划使用临时表或文件排序');
  return warnings;
}
function flattenPostgresPlan(root: unknown) {
  const steps: Array<{ nodeType: string; relation: string | null; indexName: string | null; estimatedRows: number; totalCost: number; filter: string | null }> = [];
  const visit = (value: unknown, depth: number) => { if (depth > 100 || steps.length >= 10_000) return; const node = recordValue(value); steps.push({ nodeType: nullableText(node['Node Type']) || 'Unknown', relation: nullableText(node['Relation Name']), indexName: nullableText(node['Index Name']), estimatedRows: finiteNumber(node['Plan Rows']), totalCost: finiteNumber(node['Total Cost']), filter: nullableText(node.Filter) || nullableText(node['Index Cond']) }); for (const child of Array.isArray(node.Plans) ? node.Plans : []) visit(child, depth + 1); };
  visit(root, 0); return steps;
}
function postgresPlanWarnings(steps: Array<{ nodeType: string; estimatedRows: number; indexName: string | null }>) {
  const warnings: string[] = [];
  if (steps.some((step) => step.nodeType === 'Seq Scan')) warnings.push('执行计划包含顺序扫描（Seq Scan）');
  if (steps.some((step) => step.nodeType === 'Seq Scan' && step.estimatedRows > 1000)) warnings.push('大范围扫描未使用索引');
  return warnings;
}
