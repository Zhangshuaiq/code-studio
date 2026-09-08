import { useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { autocompletion, CompletionContext } from '@codemirror/autocomplete';
import { EditorView } from '@codemirror/view';

interface RedisEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function RedisEditor({
  value,
  onChange,
  placeholder = 'GET mykey',
}: RedisEditorProps) {
  // 工作台只暴露只读命令；写命令必须通过受控审批能力实现后才能开放。
  const redisCommands = [
    // 字符串操作
    { cmd: 'GET', args: 'key', desc: '获取键的值' },
    { cmd: 'SET', args: 'key value [EX seconds] [NX|XX]', desc: '设置键的值' },
    { cmd: 'MGET', args: 'key [key ...]', desc: '获取多个键的值' },
    { cmd: 'MSET', args: 'key value [key value ...]', desc: '设置多个键值对' },
    { cmd: 'INCR', args: 'key', desc: '键值加1' },
    { cmd: 'DECR', args: 'key', desc: '键值减1' },
    { cmd: 'APPEND', args: 'key value', desc: '追加值到键' },
    { cmd: 'STRLEN', args: 'key', desc: '获取值的长度' },

    // 哈希操作
    { cmd: 'HGET', args: 'key field', desc: '获取哈希字段值' },
    { cmd: 'HSET', args: 'key field value', desc: '设置哈希字段值' },
    { cmd: 'HMGET', args: 'key field [field ...]', desc: '获取多个哈希字段' },
    { cmd: 'HMSET', args: 'key field value [field value ...]', desc: '设置多个哈希字段' },
    { cmd: 'HGETALL', args: 'key', desc: '获取所有哈希字段和值' },
    { cmd: 'HDEL', args: 'key field [field ...]', desc: '删除哈希字段' },
    { cmd: 'HEXISTS', args: 'key field', desc: '判断哈希字段是否存在' },
    { cmd: 'HKEYS', args: 'key', desc: '获取所有哈希字段' },
    { cmd: 'HVALS', args: 'key', desc: '获取所有哈希值' },

    // 列表操作
    { cmd: 'LPUSH', args: 'key value [value ...]', desc: '左侧推入元素' },
    { cmd: 'RPUSH', args: 'key value [value ...]', desc: '右侧推入元素' },
    { cmd: 'LPOP', args: 'key', desc: '左侧弹出元素' },
    { cmd: 'RPOP', args: 'key', desc: '右侧弹出元素' },
    { cmd: 'LRANGE', args: 'key start stop', desc: '获取列表范围元素' },
    { cmd: 'LLEN', args: 'key', desc: '获取列表长度' },
    { cmd: 'LINDEX', args: 'key index', desc: '获取列表指定索引元素' },

    // 集合操作
    { cmd: 'SADD', args: 'key member [member ...]', desc: '添加集合成员' },
    { cmd: 'SMEMBERS', args: 'key', desc: '获取所有集合成员' },
    { cmd: 'SISMEMBER', args: 'key member', desc: '判断是否是集合成员' },
    { cmd: 'SREM', args: 'key member [member ...]', desc: '删除集合成员' },
    { cmd: 'SCARD', args: 'key', desc: '获取集合成员数' },
    { cmd: 'SUNION', args: 'key [key ...]', desc: '集合并集' },
    { cmd: 'SINTER', args: 'key [key ...]', desc: '集合交集' },

    // 有序集合操作
    { cmd: 'ZADD', args: 'key score member [score member ...]', desc: '添加有序集合成员' },
    { cmd: 'ZRANGE', args: 'key start stop [WITHSCORES]', desc: '按排名获取成员' },
    { cmd: 'ZRANGEBYSCORE', args: 'key min max [WITHSCORES]', desc: '按分数获取成员' },
    { cmd: 'ZREM', args: 'key member [member ...]', desc: '删除有序集合成员' },
    { cmd: 'ZSCORE', args: 'key member', desc: '获取成员分数' },
    { cmd: 'ZCARD', args: 'key', desc: '获取有序集合成员数' },

    // 键操作
    { cmd: 'KEYS', args: 'pattern', desc: '查找匹配的键' },
    { cmd: 'EXISTS', args: 'key [key ...]', desc: '判断键是否存在' },
    { cmd: 'DEL', args: 'key [key ...]', desc: '删除键' },
    { cmd: 'EXPIRE', args: 'key seconds', desc: '设置键过期时间' },
    { cmd: 'TTL', args: 'key', desc: '获取键剩余生存时间' },
    { cmd: 'RENAME', args: 'key newkey', desc: '重命名键' },
    { cmd: 'TYPE', args: 'key', desc: '获取键的类型' },

    // 服务器操作
    { cmd: 'PING', args: '', desc: '测试连接' },
    { cmd: 'INFO', args: '[section]', desc: '获取服务器信息' },
    { cmd: 'DBSIZE', args: '', desc: '获取键数量' },
    { cmd: 'SELECT', args: 'index', desc: '切换数据库' },
    { cmd: 'FLUSHDB', args: '', desc: '清空当前数据库' },
    { cmd: 'FLUSHALL', args: '', desc: '清空所有数据库' },
  ].filter(({ cmd }) => new Set([
    'GET', 'MGET', 'EXISTS', 'TYPE', 'TTL', 'PTTL', 'STRLEN',
    'SCAN', 'HSCAN', 'SSCAN', 'ZSCAN',
    'HGET', 'HMGET', 'HGETALL', 'HLEN', 'HEXISTS', 'HKEYS', 'HVALS',
    'LRANGE', 'LINDEX', 'LLEN', 'SMEMBERS', 'SISMEMBER', 'SMISMEMBER',
    'SCARD', 'ZRANGE', 'ZREVRANGE', 'ZRANK', 'ZREVRANK', 'ZSCORE',
    'ZMSCORE', 'ZCARD', 'ZCOUNT',
  ]).has(cmd));

  // Redis 自动补全
  const redisCompletion = useMemo(
    () =>
      autocompletion({
        override: [
          (context: CompletionContext) => {
            const word = context.matchBefore(/\w*/);
            if (!word || (word.from === word.to && !context.explicit)) {
              return null;
            }

            const options = redisCommands.map((cmd) => ({
              label: cmd.cmd,
              type: 'keyword',
              detail: cmd.args,
              info: cmd.desc,
              apply: cmd.args ? `${cmd.cmd} ` : cmd.cmd,
              boost: 1,
            }));

            return {
              from: word.from,
              options,
              validFor: /^\w*$/,
            };
          },
        ],
      }),
    [redisCommands],
  );

  const extensions = useMemo(
    () => [redisCompletion, EditorView.lineWrapping],
    [redisCompletion],
  );

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      extensions={extensions}
      placeholder={placeholder}
      height="120px"
      theme="light"
      basicSetup={{
        lineNumbers: true,
        highlightActiveLineGutter: true,
        highlightActiveLine: true,
        foldGutter: false,
        dropCursor: true,
        indentOnInput: true,
        bracketMatching: true,
        closeBrackets: true,
        autocompletion: true,
        highlightSelectionMatches: true,
      }}
      className="redis-editor"
    />
  );
}
