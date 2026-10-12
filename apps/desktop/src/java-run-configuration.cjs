// Run arguments may contain passwords. Never persist them as plain settings.
const { randomUUID } = require('node:crypto');
class JavaRunConfigurationStore {
  constructor(store, codec) { this.store = store; this.codec = codec; }
  key(project) { return `java.runConfiguration.${project.id}`; }
  available() {
    if (!this.store) throw Object.assign(new Error('本地配置存储不可用'), { code: 'LOCAL_JAVA_CONFIGURATION_UNAVAILABLE' });
    if (!this.codec?.available?.()) throw Object.assign(new Error('系统凭据加密不可用，无法保存或恢复运行参数'), { code: 'LOCAL_CREDENTIAL_STORE_UNAVAILABLE' });
  }
  read(project) {
    if (this.store?.getSetting(this.collectionKey(project))) {
      const collection = this.list(project);
      const selected = collection.configurations.find(item => item.id === collection.selectedId);
      return selected ? validateConfiguration(selected) : null;
    }
    return this.readLegacy(project);
  }
  readLegacy(project) {
    const ciphertext = this.store?.getSetting(this.key(project));
    if (!ciphertext) return null;
    this.available();
    try { return validateConfiguration(JSON.parse(this.codec.decrypt(ciphertext))); }
    catch { throw Object.assign(new Error('无法恢复运行配置，请重新保存或清除配置'), { code: 'LOCAL_JAVA_CONFIGURATION_INVALID' }); }
  }
  save(project, input) {
    const configuration = validateConfiguration(input);
    if (this.store?.getSetting(this.collectionKey(project))) {
      const collection = this.list(project);
      const selected = collection.configurations.find(item => item.id === collection.selectedId);
      this.mutate(project, { operation: 'save', ...(selected ? { id: selected.id } : {}), name: selected?.name || '默认配置', ...configuration });
      return configuration;
    }
    this.available();
    const ciphertext = this.codec.encrypt(JSON.stringify(configuration));
    this.store.setSetting(this.key(project), ciphertext);
    return configuration;
  }
  remove(project) { this.store?.deleteSetting(this.key(project)); this.store?.deleteSetting(this.collectionKey(project)); }
  collectionKey(project) { return `java.runConfigurations.${project.id}`; }
  list(project) {
    const ciphertext = this.store?.getSetting(this.collectionKey(project));
    if (!ciphertext) {
      const legacy = this.readLegacy(project);
      return legacy ? { selectedId: 'legacy', configurations: [{ id: 'legacy', name: '默认配置', ...legacy }] } : { selectedId: null, configurations: [] };
    }
    this.available();
    try { return validateCollection(JSON.parse(this.codec.decrypt(ciphertext))); }
    catch { throw Object.assign(new Error('无法恢复运行配置列表，请检查本地凭据存储'), { code: 'LOCAL_JAVA_CONFIGURATION_INVALID' }); }
  }
  mutate(project, input) {
    this.available();
    if (!input || !['save', 'select', 'remove'].includes(input.operation)) configurationInvalid();
    const collection = this.list(project);
    if (input.operation === 'save') {
      const configuration = validateConfiguration(input);
      const name = validateName(input.name);
      if (input.id !== undefined && !collection.configurations.some(item => item.id === input.id)) configurationInvalid();
      const id = input.id || randomUUID();
      if (collection.configurations.some(item => item.name === name && item.id !== id)) configurationInvalid('配置名称已存在');
      const entry = { id, name, ...configuration };
      const index = collection.configurations.findIndex(item => item.id === id);
      if (index === -1) collection.configurations.push(entry); else collection.configurations[index] = entry;
      collection.selectedId = id;
    } else {
      const index = collection.configurations.findIndex(item => item.id === input.id);
      if (index === -1) configurationInvalid('运行配置已不存在');
      if (input.operation === 'select') collection.selectedId = input.id;
      else {
        collection.configurations.splice(index, 1);
        if (collection.selectedId === input.id) collection.selectedId = collection.configurations[0]?.id || null;
      }
    }
    const result = validateCollection(collection);
    this.store.setSetting(this.collectionKey(project), this.codec.encrypt(JSON.stringify(result)));
    this.store.deleteSetting(this.key(project));
    return result;
  }
}
function configurationInvalid(message = 'Java 运行配置无效') { throw Object.assign(new Error(message), { code: 'LOCAL_JAVA_CONFIGURATION_INVALID' }); }
function validateName(value) {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) configurationInvalid();
  const name = value.normalize('NFC').trim();
  if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) configurationInvalid('配置名称应为 1～80 个字符且不含控制字符');
  return name;
}
function validateCollection(input) {
  if (!input || !Array.isArray(input.configurations) || input.configurations.length > 20) configurationInvalid('最多保存 20 个运行配置');
  const names = new Set(); const ids = new Set();
  const configurations = input.configurations.map(item => {
    if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id) || ids.has(item.id)) configurationInvalid();
    const name = validateName(item.name);
    if (names.has(name)) configurationInvalid();
    ids.add(item.id); names.add(name);
    return { id: item.id, name, ...validateConfiguration(item) };
  });
  if (configurations.length ? !ids.has(input.selectedId) : input.selectedId !== null) configurationInvalid();
  return { selectedId: input.selectedId, configurations };
}
function validateConfiguration(input) {
  const invalid = () => { throw Object.assign(new Error('Java 运行配置无效'), { code: 'LOCAL_JAVA_CONFIGURATION_INVALID' }); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  if (typeof input.mainClass !== 'string' || !input.mainClass || input.mainClass.length > 1000 || /[\s\0]/.test(input.mainClass)) invalid();
  if (input.projectName !== undefined && (typeof input.projectName !== 'string' || input.projectName.length > 1000 || /[\r\n\0]/.test(input.projectName))) invalid();
  for (const key of ['args', 'vmArgs']) if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 8000 || input[key].includes('\0'))) invalid();
  return { mainClass: input.mainClass, ...(input.projectName !== undefined ? { projectName: input.projectName } : {}), args: input.args || '', vmArgs: input.vmArgs || '' };
}
module.exports = { JavaRunConfigurationStore, validateConfiguration, validateCollection };
