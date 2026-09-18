import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

export type MonitoringKind = 'opensearch' | 'prometheus' | 'tempo';
export type AuthType = 'none' | 'basic' | 'bearer';
export interface MonitoringConnection { kind: MonitoringKind; enabled: boolean; configured: boolean; source: 'interface'|'environment'|'none'; url: string; authType: AuthType; username: string; hasSecret: boolean }
export interface MonitoringInput { enabled: boolean; url: string; authType: AuthType; username?: string; secret?: string; clearSecret?: boolean }

export function useMonitoringConfig() { return useQuery<MonitoringConnection[]>({ queryKey: ['monitoring-config'], queryFn: async()=> (await api.get('/monitoring-config')).data }); }
export function useMonitoringConfigActions() { const qc=useQueryClient(); const save=useMutation({ mutationFn: ({kind,input}:{kind:MonitoringKind;input:MonitoringInput})=>api.put(`/monitoring-config/${kind}`,input), onSuccess:()=>{void qc.invalidateQueries({queryKey:['monitoring-config']});void qc.invalidateQueries({queryKey:['platform-health']});} }); const test=useMutation({ mutationFn: async(kind:MonitoringKind)=>(await api.post(`/monitoring-config/${kind}/test`,{})).data }); return {save,test}; }
