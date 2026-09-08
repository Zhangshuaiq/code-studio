import { Controller, Get, Headers, Param, Res, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { createReadStream } from 'node:fs';
import { PreviewSourceSnapshotService } from './preview-source-snapshot.service';

@Controller('preview-sources')
export class PreviewSourceController {
  constructor(private readonly snapshots: PreviewSourceSnapshotService) {}

  @Get(':id')
  async download(@Param('id') id: string, @Headers('authorization') authorization: string | undefined, @Res() response: Response) {
    const match = /^Bearer ([A-Za-z0-9_-]{40,})$/.exec(authorization || '');
    if (!match) throw new UnauthorizedException({ code: 'PREVIEW_SNAPSHOT_TOKEN_REQUIRED', message: '缺少构建快照下载凭证' });
    const row = await this.snapshots.open(id, match[1]);
    response.setHeader('Content-Type', 'application/gzip');
    response.setHeader('Content-Length', String(row.sizeBytes));
    response.setHeader('Digest', `sha-256=${Buffer.from(row.sha256, 'hex').toString('base64')}`);
    response.setHeader('Cache-Control', 'private, no-store');
    createReadStream(row.archivePath).on('error', () => response.destroy()).pipe(response);
  }
}
