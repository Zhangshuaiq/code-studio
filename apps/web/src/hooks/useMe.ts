import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../store/auth';

export interface Me {
  id: string;
  username: string;
  email: string | null;
  roles: string[];
  permissions: string[];
}

export function useMe() {
  const token = useAuth((s) => s.token);
  return useQuery<Me>({
    queryKey: ['me'],
    enabled: !!token,
    queryFn: async () => (await api.get('/auth/me')).data,
    staleTime: 60_000,
  });
}

export function useHasPermission(perm: string): boolean {
  const { data } = useMe();
  return !!data?.permissions.includes(perm);
}

/** 是否具备任一管理权限（决定是否显示“管理后台”入口） */
export function useIsAdmin(): boolean {
  const { data } = useMe();
  return !!data?.permissions.some((p) => p.startsWith('admin:'));
}
