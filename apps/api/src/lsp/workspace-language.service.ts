import { BadRequestException, ConflictException, Injectable, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { resolve } from 'path';
import { realpathSync } from 'fs';
import { ProjectAccessService } from '../project-access/project-access.service';
import { WorkspaceService } from '../workspace/workspace.service';
import { LanguageRequestDto } from './dto/language-request.dto';

const { LocalLspManager } = require('@codegen/code-intelligence');
const { FastIndexManager } = require('@codegen/code-intelligence/fast-index-manager.cjs');
const { relatedLocations, closeRelations, invalidateRelations } = require('@codegen/code-intelligence/workspace-relations.cjs');
const FAST_OPERATIONS = new Set(['fast-symbols', 'fast-document-symbols', 'index-status', 'index-refresh', 'related-locations']);
const OPERATIONS = new Set(['format', 'prepare', 'status', 'definition', 'declaration', 'type-definition', 'implementation', 'references', 'hover', 'completion', 'completion-resolve', 'diagnostics', 'rename', 'code-actions', 'call-hierarchy-prepare', 'call-hierarchy-incoming', 'call-hierarchy-outgoing', 'document-symbols', 'workspace-symbols', ...FAST_OPERATIONS]);

@Injectable()
export class WorkspaceLanguageService implements OnModuleDestroy {
  private readonly manager: InstanceType<typeof LocalLspManager>;
  private readonly fastIndex: InstanceType<typeof FastIndexManager>;
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(private readonly config: ConfigService, private readonly access: ProjectAccessService, private readonly workspaces: WorkspaceService) {
    this.fastIndex = new FastIndexManager({
      directory: resolve(config.get<string>('FAST_INDEX_ROOT', '.data/fast-index')),
      maxWorkers: Number(config.get('FAST_INDEX_MAX_WORKERS', 2)),
      intervalMs: Number(config.get('FAST_INDEX_INTERVAL_MS', 120_000)),
    });
    this.manager = new LocalLspManager({
      dataRoot: resolve(config.get<string>('LSP_DATA_ROOT', '.data/language')),
      idleMs: 10 * 60_000,
      maxSessions: 32,
      resources: { jdtlsHome: config.get('CODE_STUDIO_JDTLS_HOME'), javaToolsRoot: config.get('CODE_STUDIO_JAVA_TOOLS_ROOT') },
    });
  }

  async execute(userId: string, sessionId: string, operation: string, input: LanguageRequestDto = {}) {
    if (!FAST_OPERATIONS.has(operation)) this.assertEnabled();
    if (!OPERATIONS.has(operation)) throw new BadRequestException('不支持该代码导航操作');
    const permission = ['format', 'rename', 'code-actions'].includes(operation) ? 'edit' : 'read';
    const session = await this.access.requireSession(userId, sessionId, permission);
    const workspace = await this.workspaces.ensureForSession(userId, sessionId);
    const root = realpathSync(workspace.path);
    const id = createHash('sha256').update(JSON.stringify([userId, session.projectId, root, workspace.branch])).digest('hex');
    const project = { id, path: root };
    if (operation === 'status') {
      // Status must not wait behind a potentially long JDT initialize request.
      const result = this.manager.projectStatus(project);
      await this.access.requireSession(userId, sessionId, 'read');
      const current = await this.workspaces.ensureForSession(userId, sessionId);
      if (realpathSync(current.path) !== root || current.branch !== workspace.branch) throw new ConflictException('工作区已切换，请重新尝试');
      return { providers: result.providers.map(({ provider, phase, message, elapsedMs, backgroundTasks }: { provider: string; phase: string; message: string; elapsedMs: number; backgroundTasks?: number }) => ({ provider, phase, message, elapsedMs, backgroundTasks })) };
    }
    const queueId = FAST_OPERATIONS.has(operation) ? `${id}:fast` : id;
    // Serialize unsaved-buffer updates and queries in the same user's workspace.
    // Separate users never share document state, even for the same project.
    // Progress reads do not mutate document buffers. Never put them behind a
    // cold relation scan, otherwise the UI cannot show progress during loading.
    const serialized = operation !== 'index-status';
    const previous = serialized ? this.queues.get(queueId) || Promise.resolve() : Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      await this.access.requireSession(userId, sessionId, permission);
      try {
        const path = input.path || (typeof input.item?.path === 'string' ? input.item.path : undefined);
        const needsPosition = !['format', 'prepare', 'workspace-symbols', 'diagnostics', 'document-symbols', 'call-hierarchy-incoming', 'call-hierarchy-outgoing', ...FAST_OPERATIONS].includes(operation);
        if (!['prepare', 'workspace-symbols', 'fast-symbols', 'index-status', 'index-refresh'].includes(operation) && (!path || (needsPosition && (!input.line || !input.column)))) throw new BadRequestException('代码位置无效');
        if (Buffer.byteLength(JSON.stringify(input)) > 1_000_000) throw new BadRequestException('编辑内容过大');
        if (operation === 'fast-symbols' && (!input.query?.trim() || input.query.includes('\0'))) throw new BadRequestException('搜索内容无效');
        if (operation === 'fast-document-symbols' && (!path || /[\0\\]/.test(path) || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').includes('..') || !/\.java$/i.test(path))) throw new BadRequestException('文件路径无效');
        if (input.documents?.length && !FAST_OPERATIONS.has(operation)) await this.manager.syncDocuments(project, input.documents);
        const params = { ...input, path };
        let result;
        const javaDocuments = (input.documents || []).filter(document => document.path.endsWith('.java'));
        if (path?.endsWith('.java') && input.content !== undefined) {
          const existing = javaDocuments.findIndex(document => document.path === path);
          if (existing >= 0) javaDocuments.splice(existing, 1);
          javaDocuments.push({ path, content: input.content });
        }
        if (operation === 'related-locations') result = { result: await relatedLocations(root, input, { cacheDirectory: resolve(this.config.get<string>('RELATIONS_INDEX_ROOT', '.data/relations-index')) }) };
        else if (operation === 'fast-symbols') result = await this.fastIndex.search(project, input.query || '', 200, javaDocuments);
        else if (operation === 'fast-document-symbols') result = await this.fastIndex.outline(project, path, javaDocuments);
        else if (operation === 'index-status') result = { index: await this.fastIndex.status(project) };
        else if (operation === 'index-refresh') { await this.fastIndex.invalidate(project, true); result = { index: await this.fastIndex.status(project) }; }
        else if (operation === 'prepare') {
          void this.fastIndex.warm(project).catch(() => {});
          const prepared = await this.manager.prepareProject(project);
          result = { providers: prepared.providers.map((provider: { provider: string; ready: boolean }) => ({ provider: provider.provider, ready: provider.ready })) };
        }
        else if (operation === 'workspace-symbols') result = { items: await this.manager.workspaceSymbols(project, input.query || '') };
        else if (operation === 'diagnostics') result = { result: await this.manager.diagnostics(project, params) };
        else if (operation === 'rename') result = { result: await this.manager.rename(project, params) };
        else if (operation === 'code-actions') result = { result: await this.manager.codeActions(project, params) };
        else if (operation.startsWith('call-hierarchy-')) result = { result: await this.manager.callHierarchy(project, operation.slice('call-hierarchy-'.length), params) };
        else result = { result: await this.manager.request(project, ({ 'type-definition': 'typeDefinition', 'document-symbols': 'documentSymbols' } as Record<string, string>)[operation] || operation, params) };
        await this.access.requireSession(userId, sessionId, permission);
        const current = await this.workspaces.ensureForSession(userId, sessionId);
        if (realpathSync(current.path) !== root || current.branch !== workspace.branch) throw new ConflictException('工作区已切换，请重新尝试跳转');
        return result;
      } catch (error) { throw this.publicError(error); }
    });
    if (serialized) this.queues.set(queueId, pending);
    try { return await pending; } finally { if (this.queues.get(queueId) === pending) this.queues.delete(queueId); }
  }

  async source(userId: string, sessionId: string, path: string) {
    this.assertEnabled();
    if (!/^@java-source\/[a-f0-9]{24}\/[^/\\\0]+\.java$/.test(path || '')) throw new BadRequestException('依赖源码引用无效');
    const session = await this.access.requireSession(userId, sessionId, 'read');
    const workspace = await this.workspaces.ensureForSession(userId, sessionId);
    const root = realpathSync(workspace.path);
    const id = createHash('sha256').update(JSON.stringify([userId, session.projectId, root, workspace.branch])).digest('hex');
    try {
      const result = await this.manager.javaSource({ id, path: root }, path);
      await this.access.requireSession(userId, sessionId, 'read');
      const current = await this.workspaces.ensureForSession(userId, sessionId);
      if (realpathSync(current.path) !== root || current.branch !== workspace.branch) throw new ConflictException('工作区已切换，请重新打开依赖源码');
      return { ...result, path };
    } catch (error) { throw this.publicError(error); }
  }

  workspaceChanged(root: string) { invalidateRelations(root); void this.fastIndex.invalidateRoot(root).catch(() => {}); }
  async onModuleDestroy() { await Promise.all([this.manager.shutdown(), this.fastIndex.close(), closeRelations()]); }
  private assertEnabled() {
    if (this.config.get<string>('LSP_ENABLED', 'false') !== 'true') throw new ServiceUnavailableException({ code: 'LSP_DISABLED', message: '服务器尚未启用代码语言服务' });
  }
  private publicError(error: unknown) {
    const value = error as { getStatus?: () => number; code?: string; message?: string };
    if (value.getStatus) return error;
    if (value.code === 'FAST_INDEX_OVERLAY_INVALID') return new BadRequestException({ code: value.code, message: '未保存代码的路径或内容无效，请检查文件及编辑内容大小' });
    if (value.code?.startsWith('FAST_INDEX_')) return new ServiceUnavailableException({ code: value.code === 'FAST_INDEX_BUSY' ? 'FAST_INDEX_BUSY' : 'FAST_INDEX_UNAVAILABLE', message: value.code === 'FAST_INDEX_BUSY' ? '正在等待索引资源，请稍后重试' : '索引暂不可用，请稍后重试' });
    if (value.code === 'LOCAL_LSP_REFACTOR_UNSUPPORTED') return new BadRequestException({ code: 'LSP_REFACTOR_UNSUPPORTED', message: value.message });
    if (value.code === 'WORKSPACE_PATH_INVALID' || value.code === 'LOCAL_LSP_REQUEST_INVALID' || value.code === 'ENOENT') return new BadRequestException({ code: 'LSP_REQUEST_INVALID', message: '文件路径或代码位置无效' });
    if (value.code === 'LOCAL_LSP_SOURCE_INVALID') return new ConflictException({ code: 'LSP_SOURCE_INVALID', message: '依赖源码引用已失效，请重新跳转' });
    return new ServiceUnavailableException({ code: 'LSP_UNAVAILABLE', message: '语言服务暂不可用，请检查服务器语言组件配置后重试' });
  }
}
