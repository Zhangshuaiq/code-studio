import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  Query,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../auth/jwt.strategy';
import { FilesService } from './files.service';
import { WriteFileDto } from './dto/write-file.dto';
import { SearchFilesDto } from './dto/search-files.dto';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { PERMISSIONS } from '../auth/permissions';
import { WorkspaceLockInterceptor } from '../workspace/workspace-lock.interceptor';

// archiver 的 @types 不含可调用工厂签名，这里用 require + 宽松类型
// eslint-disable-next-line @typescript-eslint/no-var-requires
const createZip = require('archiver') as (
  format: string,
  options?: unknown,
) => any;

@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(PERMISSIONS.PROJECT_READ)
@Controller('sessions/:id/files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  /** 列出项目卷内文件（相对路径数组） */
  @Get()
  list(@CurrentUser() user: AuthUser, @Param('id') sessionId: string) {
    return this.files.list(user.id, sessionId);
  }

  /** 读取单个文件内容 */
  @Get('content')
  read(
    @CurrentUser() user: AuthUser,
    @Param('id') sessionId: string,
    @Query('path') path: string,
  ) {
    return this.files.read(user.id, sessionId, path);
  }

  /** 为浏览器语言服务加载受限源码模型，不包含依赖、隐藏文件或大文件。 */
  @Get('index')
  index(@CurrentUser() user: AuthUser, @Param('id') sessionId: string) {
    return this.files.sourceIndex(user.id, sessionId);
  }

  /** 工作区文件名与正文的有界字面量搜索。 */
  @Get('search')
  search(@CurrentUser() user: AuthUser, @Param('id') sessionId: string, @Query() query: SearchFilesDto) {
    return this.files.search(user.id, sessionId, query.query, query.caseSensitive);
  }

  /** 下载整个项目为 zip（排除 node_modules/.git 等） */
  @Get('download')
  async download(
    @CurrentUser() user: AuthUser,
    @Param('id') sessionId: string,
    @Res() res: Response,
  ) {
    const { root, name } = await this.files.projectVolume(user.id, sessionId);
    const safeName = (name || 'project').replace(/[^\w.\-一-龥]+/g, '_');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeName}.zip"`,
    );
    const archive = createZip('zip', { zlib: { level: 9 } });
    archive.on('error', () => res.status(500).end());
    archive.pipe(res);
    archive.glob('**/*', {
      cwd: root,
      dot: false,
      ignore: [
        'node_modules/**',
        '.git/**',
        'dist/**',
        'build/**',
        '.vite/**',
        'target/**', // Java/Maven 编译产物
        '__pycache__/**', // Python 缓存
        '.venv/**',
        'venv/**',
        '**/*.class',
        '**/*.pyc',
        '.aider*',
        'package-lock.json',
      ],
    });
    await archive.finalize();
  }

  /** 保存文件内容 */
  @Put('content')
  @RequirePermissions(PERMISSIONS.PROJECT_WRITE)
  @UseInterceptors(WorkspaceLockInterceptor)
  write(
    @CurrentUser() user: AuthUser,
    @Param('id') sessionId: string,
    @Body() dto: WriteFileDto,
  ) {
    return this.files.write(user.id, sessionId, dto.path, dto.content);
  }
}
