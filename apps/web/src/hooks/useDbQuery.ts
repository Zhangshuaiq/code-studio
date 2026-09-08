import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

// 执行查询
export function useExecuteQuery() {
  return useMutation({
    mutationFn: async ({
      datasourceId,
      payload,
    }: {
      datasourceId: string;
      payload: any;
    }) => {
      const res = await api.post(`/db-query/${datasourceId}/execute`, payload);
      return res.data;
    },
  });
}

// 获取数据库列表
export function useListDatabases(
  datasourceId: string | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: ["databases", datasourceId],
    queryFn: async () => {
      if (!datasourceId) return [];
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
) {
  return useQuery({
    queryKey: ["tables", datasourceId, database],
    queryFn: async () => {
      if (!datasourceId) return [];
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
) {
  return useQuery({
    queryKey: ["table-structure", datasourceId, tableName, database],
    queryFn: async () => {
      if (!datasourceId || !tableName) return null;
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
