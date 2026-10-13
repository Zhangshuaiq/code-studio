function sqlBindingPreference(input) {
  if (!input || typeof input !== 'object') throw new Error('SQL 绑定设置无效');
  for (const [key, limit] of [['connectionId', 128], ['database', 128], ['table', 512]]) if (typeof input[key] !== 'string' || input[key].length > limit || input[key].includes('\0')) throw new Error('SQL 绑定引用无效');
  if (input.connectionId && !/^[a-zA-Z0-9_-]+$/.test(input.connectionId)) throw new Error('SQL 连接引用无效');
  return { connectionId: input.connectionId, database: input.database, table: input.table };
}
module.exports = { sqlBindingPreference };
