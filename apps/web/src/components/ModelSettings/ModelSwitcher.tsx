import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useModelConfigs } from "../../hooks/useModelConfigs";
import { Select } from "../common/Select";

// 对话框旁的模型切换器：选当前会话用哪套配置
export function ModelSwitcher({ sessionId }: { sessionId?: string }) {
  const { data: configs = [], isLoading } = useModelConfigs();
  const [selected, setSelected] = useState<string>("");

  // 默认选中「默认配置」
  useEffect(() => {
    if (!selected && configs.length) {
      setSelected((configs.find((c) => c.isDefault) ?? configs[0]).id);
    }
  }, [configs, selected]);

  async function handleChange(id: string) {
    setSelected(id);
    if (sessionId) {
      await api.patch(`/sessions/${sessionId}`, { modelConfigId: id });
    }
  }

  if (configs.length === 0) {
    return (
      <span className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[10px] font-semibold text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-400">
        未配置模型
      </span>
    );
  }

  return (
    <Select
      value={selected}
      onChange={handleChange}
      disabled={isLoading}
      options={configs.map((config) => ({
        value: config.id,
        label: `${config.label} · ${config.model}`,
      }))}
      size="sm"
      className="w-[190px]"
      buttonClassName="text-[11px] font-medium"
      title="当前会话使用的模型"
    />
  );
}
