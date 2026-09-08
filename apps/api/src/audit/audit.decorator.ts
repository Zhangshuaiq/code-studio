import { SetMetadata } from '@nestjs/common';

export const AUDIT_KEY = 'audit_meta';

export interface AuditMeta {
  action: string; // 动作键，如 user.create
  resourceType?: string; // 资源类型，如 user
  includeBody?: boolean;
}

/** 标注需要审计的接口；全局 AuditInterceptor 会自动补齐 actor/ip/result 并落库 */
export const Audit = (action: string, resourceType?: string, includeBody = true) =>
  SetMetadata(AUDIT_KEY, { action, resourceType, includeBody } as AuditMeta);
