import registry from '../../../../packages/code-intelligence/redis-commands.json';
export function parseRedisCommand(text: string): string[] {
  const args: string[] = []; let value = ''; let quote = ''; let active = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\\') {
      if (++i >= text.length) throw new Error('Redis 参数转义未完成');
      value += text[i]; active = true;
    } else if (quote) {
      if (char === quote) quote = ''; else value += char;
    } else if (char === '"' || char === "'") { quote = char; active = true; }
    else if (/\s/.test(char)) {
      if (char === '\n' || char === '\r') { if (text.slice(i).trim()) throw new Error('每次只能执行一条 Redis 命令'); }
      if (active) { args.push(value); value = ''; active = false; }
    } else { value += char; active = true; }
  }
  if (quote) throw new Error('Redis 参数引号未闭合');
  if (active) args.push(value);
  if (!args.length) throw new Error('请输入 Redis 命令');
  args[0] = args[0].toUpperCase();
  return args;
}
export function isDestructiveRedisCommand(command: string) {
  return registry.destructive.includes(command.toUpperCase());
}
