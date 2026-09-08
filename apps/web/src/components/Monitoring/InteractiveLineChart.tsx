import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

export type ChartSeries = {
  name: string;
  points: Array<{ timestamp: string; value: number }>;
  color: string;
  unit?: string;
  yAxisIndex?: 0 | 1;
};

export function InteractiveLineChart({ series, height = 220 }: { series: ChartSeries[]; height?: number }) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!element.current) return;
    const chart = echarts.init(element.current, undefined, { renderer: 'canvas' });
    const units = Object.fromEntries(series.map((item) => [item.name, item.unit || '']));
    chart.setOption({
      animation: false,
      color: series.map((item) => item.color),
      grid: { left: 46, right: series.some((item) => item.yAxisIndex === 1) ? 46 : 18, top: 28, bottom: 35 },
      legend: { top: 0, textStyle: { fontSize: 10 } },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross', lineStyle: { type: 'dashed', opacity: 0.6 } },
        formatter: (params: any) => {
          const rows = Array.isArray(params) ? params : [params];
          const time = rows[0]?.value?.[0] ? new Date(rows[0].value[0]).toLocaleString('zh-CN') : '';
          return [`<b>${time}</b>`, ...rows.map((row: any) => `${row.marker}${row.seriesName}：<b>${formatChartValue(Number(row.value?.[1]), units[row.seriesName])}</b>`)].join('<br/>');
        },
      },
      xAxis: { type: 'time', axisLabel: { fontSize: 9, hideOverlap: true }, splitLine: { show: false } },
      yAxis: [
        { type: 'value', axisLabel: { fontSize: 9, formatter: (value: number) => compact(value, series.find((item) => !item.yAxisIndex)?.unit) }, splitLine: { lineStyle: { opacity: 0.12 } } },
        { type: 'value', show: series.some((item) => item.yAxisIndex === 1), axisLabel: { fontSize: 9, formatter: (value: number) => compact(value, series.find((item) => item.yAxisIndex === 1)?.unit) }, splitLine: { show: false } },
      ],
      series: series.map((item) => ({ name: item.name, type: 'line', yAxisIndex: item.yAxisIndex || 0, showSymbol: false, smooth: 0.18, emphasis: { focus: 'series' }, lineStyle: { width: 2 }, areaStyle: { opacity: 0.05 }, data: item.points.map((point) => [point.timestamp, point.value]) })),
    });
    const observer = new ResizeObserver(() => chart.resize()); observer.observe(element.current);
    return () => { observer.disconnect(); chart.dispose(); };
  }, [series]);
  return <div ref={element} style={{ height }} className="w-full" />;
}

function formatChartValue(value: number, unit?: string) {
  if (unit === 'bytes') return bytes(value);
  if (unit === 'bytes/s') return `${bytes(value)}/s`;
  if (unit === 'percent') return `${value.toFixed(2)}%`;
  if (unit === 'cores') return `${value.toFixed(3)} 核`;
  if (unit === 'ms') return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${value.toFixed(1)}ms`;
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
}
function compact(value: number, unit?: string) { if (unit === 'bytes' || unit === 'bytes/s') return bytes(value); if (unit === 'percent') return `${value}%`; if (unit === 'cores') return value.toFixed(2); if (value >= 1000) return `${(value / 1000).toFixed(1)}k`; return String(Number(value.toFixed(1))); }
function bytes(value: number) { if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)}GiB`; if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)}MiB`; if (value >= 1024) return `${(value / 1024).toFixed(1)}KiB`; return `${value.toFixed(0)}B`; }
