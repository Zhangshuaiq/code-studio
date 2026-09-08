import type { ProjectRuntime } from '../../sandbox/language-runtime';

export interface AgentEvent {
  kind: 'text' | 'tool_use' | 'result' | 'system';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
}

// 每用户自带的模型凭证（BYOK），由 ModelConfigService 解析后注入
export interface ModelCredential {
  provider: string; // 'openai-compatible' 等
  engine: string; // 生成引擎: 'simple' | 'aider'
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface GenerationInput {
  userId: string;
  prompt: string;
  cwd: string; // 项目挂载卷（生成的文件写这里）
  runtime: ProjectRuntime;
  resumeId?: string; // 多轮延续标识（claude-agent 用）
  credentials?: ModelCredential; // BYOK：本次生成用哪套模型/key
  onEvent?: (e: AgentEvent) => void;
  signal?: AbortSignal;
}

export interface GenerationResult {
  events: AgentEvent[];
  isError: boolean;
  contextId?: string; // 供下一轮 resume
}

// 生成引擎抽象：claude-agent（真智能体）/ simple-llm（免费平替）可切换
export interface GenerationProvider {
  generate(input: GenerationInput): Promise<GenerationResult>;
}
