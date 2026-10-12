import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

export interface DbQueryTransport {
  scope: string;
  execute(id: string, payload: any): Promise<any>;
  databases(id: string, signal?: AbortSignal): Promise<string[]>;
  tables(id: string, database?: string, signal?: AbortSignal): Promise<string[]>;
  describe(id: string, table: string, database?: string, signal?: AbortSignal): Promise<any>;
  selectSql?(table: string): string;
}

// 执行查询
export function useExecuteQuery(transport?: DbQueryTransport) {
  return useMutation({
    mutationFn: async ({
      datasourceId,
      payload,
    }: {
      datasourceId: string;
      payload: any;
    }) => {
      if (transport) return transport.execute(datasourceId, payload);
      const res = await api.post(`/db-query/${datasourceId}/execute`, payload);
      return res.data;
    },
  });
}

// 获取数据库列表
export function useListDatabases(
  datasourceId: string | undefined,
  enabled = true,
  transport?: DbQueryTransport,
) {
  return useQuery({
    queryKey: transport ? ['local-db', transport.scope, 'databases', datasourceId] : ["databases", datasourceId],
    queryFn: async ({ signal }) => {
      if (!datasourceId) return [];
      if (transport) return transport.databases(datasourceId, signal);
      const res = await api.get(`/db-query/${datasourceId}/databases`);
      return res.data as string[];
    },
    enabled: enabled && !!datasourceId,
  });
}

// 获取表列表
export function useListTables(
  datasourceId: string | undefined,
  database?: string,
  enabled = true,
  transport?: DbQueryTransport,
) {
  return useQuery({
    queryKey: transport ? ['local-db', transport.scope, 'tables', datasourceId, database] : ["tables", datasourceId, database],
    queryFn: async ({ signal }) => {
      if (!datasourceId) return [];
      if (transport) return transport.tables(datasourceId, database, signal);
      const params = database ? { database } : {};
      const res = await api.get(`/db-query/${datasourceId}/tables`, {
        params,
      });
      return res.data as string[];
    },
    enabled: enabled && !!datasourceId,
  });
}

// 获取表结构
export function useDescribeTable(
  datasourceId: string | undefined,
  tableName: string | undefined,
  database?: string,
  enabled = true,
  transport?: DbQueryTransport,
) {
  return useQuery({
    queryKey: transport ? ['local-db', transport.scope, 'table-structure', datasourceId, tableName, database] : ["table-structure", datasourceId, tableName, database],
    queryFn: async ({ signal }) => {
      if (!datasourceId || !tableName) return null;
      if (transport) return transport.describe(datasourceId, tableName, database, signal);
      const params = database ? { database } : {};
      const res = await api.get(
        `/db-query/${datasourceId}/tables/${tableName}/describe`,
        { params },
      );
      return res.data;
    },
    enabled: enabled && !!datasourceId && !!tableName,
  });
}
