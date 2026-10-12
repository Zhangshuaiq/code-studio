import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useOrganizationControl } from "../../lib/organization-control";
import { Card, errText } from "../Settings/ui";
import { useFeedback } from "../common/FeedbackProvider";
import { isAxiosError } from "axios";

interface Domain {
  id: string;
  domain: string;
  expiresAt: string;
  verifiedAt: string | null;
  recordName: string;
  recordValue: string;
}
export function OrganizationDomains({
  organizationId,
  scope = "platform",
}: {
  organizationId: string;
  scope?: "platform" | "organization";
}) {
  const { api, identity: username } = useOrganizationControl();
  const qc = useQueryClient();
  const { confirm } = useFeedback();
  const [domain, setDomain] = useState("");
  const [error, setError] = useState("");
  const key = ["organization-domains", scope, username, organizationId];
  const base =
    scope === "organization"
      ? `/control/enterprise/organizations/${organizationId}/domains`
      : `/admin/organizations/${organizationId}/domains`;
  const domains = useQuery<Domain[]>({
    queryKey: key,
    queryFn: async () => (await api.get(base)).data,
    retry: (count, reason) => !(isAxiosError(reason) && [401, 403].includes(reason.response?.status ?? 0)) && count < 2,
  });
  const action = useMutation({
    mutationFn: async ({
      operation,
      id,
    }: {
      operation: "create" | "verify" | "remove";
      id?: string;
    }) => {
      if (operation === "create") return api.post(base, { domain });
      if (operation === "verify") return api.post(`${base}/${id}/verify`);
      return api.delete(`${base}/${id}`);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: ["organizations"] });
      void qc.invalidateQueries({
        queryKey: ["organization-audit", username, organizationId],
      });
    },
  });
  async function perform(
    operation: "create" | "verify" | "remove",
    id?: string,
  ) {
    if (
      operation === "remove" &&
      !(await confirm({
        title: "移除企业域名",
        message: "移除后该域名将不再属于此组织的已验证域名。",
        tone: "danger",
      }))
    )
      return;
    setError("");
    try {
      await action.mutateAsync({ operation, id });
      if (operation === "create") setDomain("");
    } catch (reason) {
      setError(errText(reason));
    }
  }
  return (
    <div data-organization-domains><Card title="企业域名">
      <p className="mb-3 text-xs text-muted">
        通过 DNS TXT
        记录确认域名所有权。验证域名不会自动为该域名的账户授予组织权限。
      </p>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void perform("create");
        }}
      >
        <input
          className="input min-w-0 flex-1"
          aria-label="企业域名"
          placeholder="company.com"
          maxLength={253}
          value={domain}
          onChange={(event) => setDomain(event.target.value)}
          required
        />
        <button className="btn btn-primary" disabled={action.isPending}>
          生成验证记录
        </button>
      </form>
      {(error || domains.error) && (
        <p className="mt-3 text-xs text-red-500" role="alert">
          {error || errText(domains.error)}
        </p>
      )}
      <div className="mt-4 space-y-3">
        {!domains.error && domains.data?.map((item) => (
          <div
            key={item.id}
            className="rounded-xl border border-slate-200 p-3 dark:border-slate-700"
          >
            <div className="flex items-center gap-3 text-xs">
              <b className="min-w-0 flex-1 truncate">{item.domain}</b>
              <span className="text-muted">
                {item.verifiedAt
                  ? "已验证"
                  : new Date(item.expiresAt).getTime() <= Date.now()
                    ? "已过期"
                    : "待验证"}
              </span>
              {!item.verifiedAt && (
                <button
                  className="btn btn-primary btn-sm"
                  disabled={action.isPending}
                  onClick={() => void perform("verify", item.id)}
                >
                  检查 DNS
                </button>
              )}
              <button
                className="btn btn-ghost btn-sm"
                disabled={action.isPending}
                onClick={() => void perform("remove", item.id)}
              >
                移除
              </button>
            </div>
            {!item.verifiedAt && (
              <div className="mt-3 space-y-2 text-xs">
                <label className="block">
                  TXT 记录名称
                  <input
                    className="input mt-1 w-full font-mono"
                    value={item.recordName}
                    readOnly
                    onFocus={(event) => event.target.select()}
                  />
                </label>
                <label className="block">
                  TXT 记录值
                  <input
                    className="input mt-1 w-full font-mono"
                    value={item.recordValue}
                    readOnly
                    onFocus={(event) => event.target.select()}
                  />
                </label>
                <p className="text-muted">
                  有效至 {new Date(item.expiresAt).toLocaleString()}
                  ；过期后重新生成记录。
                </p>
              </div>
            )}
          </div>
        ))}
      </div>
    </Card></div>
  );
}
