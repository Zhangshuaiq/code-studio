import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** 编码 Worker 共享的 CLI 状态目录，避免 Pod/节点切换时丢失会话。 */
@Injectable()
export class AgentRuntimeStateService {
  private readonly root: string;

  constructor(private readonly config: ConfigService) {
    const workspaceRoot = resolve(config.get<string>('SANDBOX_WORKSPACES_ROOT', '.data/workspaces'));
    this.root = resolve(config.get<string>('AGENT_STATE_ROOT') || join(dirname(workspaceRoot), 'agent-state'));
  }

  async home(userId: string, tool: 'codex' | 'claude' | 'codex-api' | 'claude-api' | 'deepseek-api' | 'glm-api'): Promise<string> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(userId)) {
      throw new BadRequestException('用户标识不适合作为 Agent 状态目录');
    }
    const userRoot = join(this.root, userId);
    const path = join(userRoot, tool);
    for (const directory of [this.root, userRoot, path]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new BadRequestException('Agent 状态目录不能是符号链接');
      }
      await chmod(directory, 0o700);
    }
    return path;
  }
}
