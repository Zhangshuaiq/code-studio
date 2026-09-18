import { useEffect, useState } from 'react';
import { Activity, Gauge, Waypoints } from 'lucide-react';
import { useMonitoringConfig, useMonitoringConfigActions, type AuthType, type MonitoringConnection, type MonitoringKind } from '../../hooks/useMonitoringConfig';
import { PageHeader, Card, Field, errText } from './ui';
import { Select } from '../common/Select';

const META: Record<MonitoringKind,{title:string;description:string;placeholder:string;icon:typeof Activity}> = {
  opensearch:{title:'日志服务',description:'连接外部 OpenSearch，存储和检索业务日志。',placeholder:'https://logs.example.com',icon:Activity},
  prometheus:{title:'性能监控',description:'连接 Prometheus 兼容查询 API，展示 CPU、内存与实例指标。',placeholder:'https://metrics.example.com',icon:Gauge},
  tempo:{title:'链路追踪',description:'连接 Tempo HTTP API，检索分布式调用链路。',placeholder:'https://traces.example.com',icon:Waypoints},
};

export function MonitoringConfigPage(){ const query=useMonitoringConfig(); return <div><PageHeader title="监控与日志" desc="统一配置外部日志、性能指标和链路追踪服务。访问凭证加密保存且不会回显。"/><div className="space-y-5">{(['opensearch','prometheus','tempo'] as MonitoringKind[]).map(kind=><ConnectionCard key={kind} kind={kind} value={query.data?.find(x=>x.kind===kind)}/>)}</div></div>; }

function ConnectionCard({kind,value}:{kind:MonitoringKind;value?:MonitoringConnection}){
  const actions=useMonitoringConfigActions(); const meta=META[kind]; const Icon=meta.icon;
  const [enabled,setEnabled]=useState(false),[url,setUrl]=useState(''),[authType,setAuthType]=useState<AuthType>('none'),[username,setUsername]=useState(''),[secret,setSecret]=useState(''); const [message,setMessage]=useState('');
  useEffect(()=>{if(value){setEnabled(value.enabled);setUrl(value.url);setAuthType(value.authType);setUsername(value.username)}},[value]);
  async function save(){setMessage('');try{await actions.save.mutateAsync({kind,input:{enabled,url,authType,username,secret:secret||undefined}});setSecret('');setMessage('配置已保存并立即生效')}catch(e){setMessage(`保存失败：${errText(e)}`)}}
  async function test(){setMessage('');try{const r=await actions.test.mutateAsync(kind);setMessage(r.ok?`连接成功，耗时 ${r.latencyMs} ms`:`连接失败：${r.message}`)}catch(e){setMessage(`连接失败：${errText(e)}`)}}
  return <Card><div className="mb-5 flex items-start justify-between gap-4"><div className="flex gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10"><Icon size={19}/></span><div><h2 className="font-bold">{meta.title}</h2><p className="mt-1 text-xs text-muted">{meta.description}</p></div></div><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)} className="accent-indigo-600"/>启用</label></div><div className="grid gap-4 md:grid-cols-2"><div className="md:col-span-2"><Field label="服务地址" value={url} onChange={setUrl} placeholder={meta.placeholder}/></div><div><label className="label mb-1.5">鉴权方式</label><Select value={authType} onChange={v=>setAuthType(v as AuthType)} options={[{value:'none',label:'无需鉴权'},{value:'basic',label:'用户名与密码'},{value:'bearer',label:'Bearer Token'}]}/></div>{authType==='basic'&&<Field label="用户名" value={username} onChange={setUsername} placeholder="服务用户名"/>}{authType!=='none'&&<Field label={authType==='basic'?'密码':'Token'} value={secret} onChange={setSecret} type="password" placeholder={value?.hasSecret?'已保存；留空表示不修改':'请输入凭证'}/>}</div><div className="mt-5 flex items-center gap-3"><button className="btn btn-primary" disabled={actions.save.isPending} onClick={save}>保存配置</button><button className="btn btn-ghost" disabled={actions.test.isPending||!value?.configured} onClick={test}>测试已保存配置</button>{value?.source==='environment'&&<span className="text-xs text-amber-600">当前来自环境变量，保存后由界面配置接管</span>}{message&&<span className={`text-xs ${message.includes('失败')?'text-red-500':'text-emerald-600'}`}>{message}</span>}</div></Card>;
}
