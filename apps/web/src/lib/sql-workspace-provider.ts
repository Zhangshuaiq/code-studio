// Load the SQL parser only when SQL suggestions are requested. Java/TS projects
// do not pay for CodeMirror's parser in the workspace's initial bundle.
import type { WorkspaceSqlContext } from './workspace-sql-context';
export function installSqlWorkspaceCompletions(monaco: any, projectId: string, external?: () => WorkspaceSqlContext | undefined) {
  let disposed = false;
  let provider: ReturnType<typeof import('./sql-intelligence').createSqlWorkspaceCompletionProvider> | undefined;
  let pending: Promise<typeof provider> | undefined;
  const registration = monaco.languages.registerCompletionItemProvider('sql', {
    triggerCharacters: ['.', '"', '`'],
    provideCompletionItems: async (model: any, position: any, context: any, token: any) => {
      if (disposed || model.isDisposed() || model.uri.scheme !== 'codegen' || model.uri.authority !== projectId || token?.isCancellationRequested) return { suggestions: [] };
      const version = model.getVersionId();
      pending ||= import('./sql-intelligence').then(module => {
        if (!disposed) provider = module.createSqlWorkspaceCompletionProvider(monaco, projectId, external);
        return provider;
      }).catch(error => { pending = undefined; throw error; });
      const loaded = await pending;
      if (!loaded || disposed || model.isDisposed() || model.getVersionId() !== version || token?.isCancellationRequested) return { suggestions: [] };
      return loaded.provideCompletionItems(model, position, context, token);
    },
  });
  return { dispose() { disposed = true; provider?.dispose(); registration.dispose(); } };
}
