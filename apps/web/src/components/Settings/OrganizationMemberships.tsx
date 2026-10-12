import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useOrganizationControl } from "../../lib/organization-control";
import type { OrganizationMember } from "../../hooks/useOrganizations";
import { Select } from "../common/Select";
import { useFeedback } from "../common/FeedbackProvider";
import { Card, errText } from "./ui";
import { OrganizationInvitations } from "../Admin/OrganizationInvitations";
import { OrganizationAudit } from "./OrganizationAudit";
import { OrganizationDomains } from "../Admin/OrganizationDomains";
import { OrganizationPolicy } from "./OrganizationPolicy";
import { organizationRoleLabels as roleLabels } from '../../lib/organization-roles';

interface Membership {
  userId: string;
  role: string;
  organization: { id: string; name: string; slug: string; seatLimit: number };
}
export function OrganizationMemberships() {
  const { api, identity: username } = useOrganizationControl();
  const qc = useQueryClient();
  const { confirm } = useFeedback();
  const [selectedId, setSelectedId] = useState("");
  const [error, setError] = useState("");
  const organizations = useQuery<Membership[]>({
    queryKey: ["my-organizations", username],
    queryFn: async () =>
      (await api.get("/control/enterprise/organizations")).data,
  });
  const selected = organizations.data?.find(
    (item) => item.organization.id === selectedId,
  );
  const canManage = selected?.role === "owner" || selected?.role === "admin";
  const canReadAudit = canManage || selected?.role === 'auditor';
  useEffect(() => {
    if (
      !organizations.data?.some((item) => item.organization.id === selectedId)
    )
      setSelectedId(organizations.data?.[0]?.organization.id || "");
  }, [organizations.data, selectedId]);
  const base = `/control/enterprise/organizations/${selectedId}/members`;
  const members = useQuery<OrganizationMember[]>({
    queryKey: ["managed-organization-members", username, selectedId],
    enabled: Boolean(selectedId && canManage),
    queryFn: async () => (await api.get(base)).data,
  });
  const mutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role?: string }) =>
      role
        ? api.put(`${base}/${userId}/role`, { role })
        : api.delete(`${base}/${userId}`),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["my-organizations", username] }),
        qc.invalidateQueries({
          queryKey: ["managed-organization-members", username],
        }),
      ]);
    },
  });
  async function change(member: OrganizationMember, role?: string) {
    if (role === member.role || mutation.isPending) return;
    const accepted = await confirm({
      title: role ? "修改组织角色" : "移除组织成员",
      message: role
        ? `将 ${member.user.displayName || member.user.username} 的角色改为${roleLabels[role]}？此操作不授予平台管理员或项目权限。`
        : `从 ${selected?.organization.name} 移除 ${member.user.displayName || member.user.username}？`,
      confirmText: role ? "修改角色" : "移除",
      tone: role ? "primary" : "danger",
    });
    if (!accepted) return;
    setError("");
    try {
      await mutation.mutateAsync({ userId: member.userId, role });
    } catch (reason) {
      setError(errText(reason));
    }
  }
  return (
    <div data-organization-memberships>
      <Card title="我的组织">
        {organizations.isLoading && (
          <p className="text-xs text-muted">加载组织…</p>
        )}
        {(error || organizations.error || (canManage && members.error)) && (
          <p role="alert" className="mb-3 text-xs text-red-500">
            {error || errText(organizations.error || members.error)}
          </p>
        )}
        {!!organizations.data?.length && (
          <Select
            className="w-full"
            value={selectedId}
            disabled={mutation.isPending}
            options={organizations.data.map((item) => ({
              value: item.organization.id,
              label: `${item.organization.name} · ${roleLabels[item.role] || item.role}`,
            }))}
            onChange={(value) => {
              setSelectedId(value);
              setError("");
            }}
          />
        )}
        {organizations.data?.length === 0 && (
          <p className="text-xs text-muted">
            尚未加入组织，可使用企业邀请代码加入。
          </p>
        )}
        {selected && (
          <p className="mt-3 text-xs text-muted">
            当前角色：{roleLabels[selected.role]}
            。组织角色不等于平台角色；项目访问权限独立配置。
          </p>
        )}
        {canManage && members.isLoading && (
          <p className="mt-3 text-xs text-muted">加载成员…</p>
        )}
        {canManage && (
          <div className="mt-3 space-y-2">
            {members.data?.map((member) => (
              <div
                key={member.id}
                className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 p-3 dark:border-slate-700"
              >
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-xs">
                    {member.user.displayName || member.user.username}
                  </span>
                  <span className="text-[10px] text-muted">
                    {member.user.email} ·{" "}
                    {member.status === "active" ? "有效" : "停用"}
                  </span>
                </div>
                {selected?.role === "owner" ? (
                  <Select
                    className="w-32"
                    value={member.role}
                    disabled={mutation.isPending}
                    options={Object.entries(roleLabels).map(
                      ([value, label]) => ({ value, label }),
                    )}
                    onChange={(role) => void change(member, role)}
                  />
                ) : (
                  <span className="text-xs">{roleLabels[member.role]}</span>
                )}
                {(selected?.role === "owner" || member.role === "member") && (
                  <button
                    className="btn btn-ghost btn-sm text-red-500"
                    disabled={mutation.isPending}
                    onClick={() => void change(member)}
                  >
                    移除
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
      {canReadAudit && (
        <div className="mt-4 space-y-4">
          {canManage && <>
          <OrganizationPolicy key={`${selectedId}:${selected?.role}:${username}`} organizationId={selectedId} actorRole={selected?.role} />
          <OrganizationInvitations
            key={`${selectedId}:${selected?.role}:${username}`}
            organizationId={selectedId}
            scope="organization"
            actorRole={selected?.role}
          />
          </>}
          <OrganizationAudit key={`${selectedId}:${selected?.role}:${username}`} organizationId={selectedId} />
          {canManage && <OrganizationDomains key={`${selectedId}:${selected?.role}:${username}`} organizationId={selectedId} scope="organization" />}
        </div>
      )}
    </div>
  );
}
