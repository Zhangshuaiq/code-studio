import { createContext, useContext, type ReactNode } from 'react';
import axios, { isAxiosError, type AxiosInstance } from 'axios';
import { api } from './api';
import { useAuth } from '../store/auth';

type Connection = { api: AxiosInstance; identity: string };
const OrganizationControl = createContext<Connection | null>(null);

export function useOrganizationControl() {
  const connection = useContext(OrganizationControl);
  const username = useAuth((state) => state.username);
  return connection ?? { api, identity: username };
}

export function createDesktopOrganizationApi(sessionId: string, onSessionChanged?: () => void) {
  const client = axios.create({ baseURL: '/api/local/account', headers: { 'X-Code-Studio-Control-Session': sessionId } });
  client.interceptors.request.use((config) => {
    if (!config.url?.startsWith('/control/enterprise/organizations')) throw new Error('组织接口路径无效');
    config.url = config.url.replace(/^\/control\/enterprise/, '/enterprise');
    return config;
  });
  client.interceptors.response.use((response) => response, (reason) => {
    if (isAxiosError(reason) && (reason.response?.status === 401 || reason.response?.data?.code === 'LOCAL_CONTROL_SESSION_CHANGED')) onSessionChanged?.();
    return Promise.reject(reason);
  });
  return client;
}

export function OrganizationControlProvider({ connection, children }: { connection: Connection; children: ReactNode }) {
  return <OrganizationControl.Provider value={connection}>{children}</OrganizationControl.Provider>;
}
