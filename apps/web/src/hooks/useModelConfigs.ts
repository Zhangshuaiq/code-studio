import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../store/auth';

export interface ModelConfig {
  id: string;
  label: string;
  provider: string;
  engine: string;
  baseUrl: string;
  model: string;
  keyMasked: string;
  isDefault: boolean;
  createdAt: string;
}

export interface CreateModelConfigInput {
  label: string;
  engine: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  isDefault?: boolean;
}

export function useModelConfigs() {
  const token = useAuth((s) => s.token);
  return useQuery<ModelConfig[]>({
    queryKey: ['model-configs'],
    enabled: !!token,
    queryFn: async () => (await api.get('/model-configs')).data,
  });
}

export function useModelConfigMutations() {
  const qc = useQueryClient();
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ['model-configs'] });

  const create = useMutation({
    mutationFn: (input: CreateModelConfigInput) =>
      api.post('/model-configs', input),
    onSuccess: invalidate,
  });
  const setDefault = useMutation({
    mutationFn: (id: string) =>
      api.patch(`/model-configs/${id}`, { isDefault: true }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/model-configs/${id}`),
    onSuccess: invalidate,
  });

  return { create, setDefault, remove };
}
