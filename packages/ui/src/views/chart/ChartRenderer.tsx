import type { ChartType, SeriesData, ValueFormat } from "@app-mcp/format";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, Pie, PieChart, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

/** shadcn defines --chart-1..5. */
const PALETTE_SIZE = 5;
const color = (i: number) => `var(--chart-${(i % PALETTE_SIZE) + 1})`;

/** `compact` gives short axis ticks ("€40K"); tooltips use the full value. */
export function formatValue(value: number, format?: ValueFormat, unit?: string, compact = false): string {
  const notation = compact ? "compact" : "standard";
  if (format === "currency") {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: unit ?? "USD",
        notation,
        maximumFractionDigits: compact ? 1 : 2,
      }).format(value);
    } catch {
      return `${value} ${unit ?? ""}`.trim();
    }
  }
  if (format === "percent") return new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 }).format(value);
  const text = new Intl.NumberFormat(undefined, { notation, maximumFractionDigits: compact ? 1 : 2 }).format(value);
  return unit ? `${text} ${unit}` : text;
}

interface Props {
  type: ChartType;
  data: SeriesData;
  stacked?: boolean;
  horizontal?: boolean;
}

export function ChartRenderer({ type, data, stacked, horizontal }: Props) {
  if (type === "pie" || type === "donut") return <PieRenderer data={data} donut={type === "donut"} />;

  const config: ChartConfig = Object.fromEntries(data.series.map((s, i) => [s.key, { label: s.name, color: color(i) }]));
  const rows = data.categories.map((category, i) => ({
    category,
    ...Object.fromEntries(data.series.map((s) => [s.key, s.values[i]])),
  }));
  const first = data.series[0];
  const tick = (v: number) => formatValue(v, first?.format, first?.unit, true);
  const tooltip = (
    <ChartTooltip
      content={
        <ChartTooltipContent
          formatter={(value, name) => {
            const s = data.series.find((x) => x.key === name);
            return (
              <div className="flex w-full justify-between gap-4">
                <span className="text-muted-foreground">{s?.name ?? name}</span>
                <span className="font-mono font-medium tabular-nums">{formatValue(Number(value), s?.format, s?.unit)}</span>
              </div>
            );
          }}
        />
      }
    />
  );
  const legend = data.series.length > 1 ? <ChartLegend content={<ChartLegendContent />} /> : null;
  const stackId = stacked ? "stack" : undefined;

  if (type === "bar") {
    return (
      <ChartContainer config={config} className="aspect-auto h-64 w-full">
        <BarChart data={rows} layout={horizontal ? "vertical" : "horizontal"} accessibilityLayer>
          <CartesianGrid vertical={horizontal} horizontal={!horizontal} />
          {/* No fragments here: recharts detects them with react-is, which never matches Preact's. */}
          {horizontal ? (
            <XAxis type="number" tickFormatter={tick} tickLine={false} axisLine={false} />
          ) : (
            <XAxis dataKey="category" tickLine={false} axisLine={false} tickMargin={8} />
          )}
          {horizontal ? (
            <YAxis type="category" dataKey="category" width={96} tickLine={false} axisLine={false} />
          ) : (
            <YAxis tickFormatter={tick} tickLine={false} axisLine={false} width={56} />
          )}
          {tooltip}
          {legend}
          {data.series.map((s) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              fill={`var(--color-${s.key})`}
              stackId={stackId}
              radius={stacked ? 0 : 4}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ChartContainer>
    );
  }

  if (type === "area") {
    return (
      <ChartContainer config={config} className="aspect-auto h-64 w-full">
        <AreaChart data={rows} accessibilityLayer>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="category" tickLine={false} axisLine={false} tickMargin={8} />
          <YAxis tickFormatter={tick} tickLine={false} axisLine={false} width={56} />
          {tooltip}
          {legend}
          {data.series.map((s) => (
            <Area
              key={s.key}
              dataKey={s.key}
              type="monotone"
              stroke={`var(--color-${s.key})`}
              fill={`var(--color-${s.key})`}
              fillOpacity={0.3}
              stackId={stackId}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      </ChartContainer>
    );
  }

  return (
    <ChartContainer config={config} className="aspect-auto h-64 w-full">
      <LineChart data={rows} accessibilityLayer>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="category" tickLine={false} axisLine={false} tickMargin={8} />
        <YAxis tickFormatter={tick} tickLine={false} axisLine={false} width={56} />
        {tooltip}
        {legend}
        {data.series.map((s) => (
          <Line
            key={s.key}
            dataKey={s.key}
            type="monotone"
            stroke={`var(--color-${s.key})`}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ChartContainer>
  );
}

/** Pie and donut plot the first series, one slice per category. */
function PieRenderer({ data, donut }: { data: SeriesData; donut: boolean }) {
  const series = data.series[0];
  // Each slice carries its own `fill`, which recharts reads from the data.
  const slices = data.categories.map((name, i) => ({ key: `c${i}`, name, value: series?.values[i] ?? 0, fill: `var(--color-c${i})` }));
  const config: ChartConfig = Object.fromEntries(slices.map((s, i) => [s.key, { label: s.name, color: color(i) }]));
  return (
    <ChartContainer config={config} className="mx-auto aspect-square h-64">
      <PieChart>
        <ChartTooltip
          content={
            <ChartTooltipContent
              nameKey="key"
              hideLabel
              formatter={(value, _name, item) => (
                <div className="flex w-full justify-between gap-4">
                  <span className="text-muted-foreground">{(item.payload as { name: string }).name}</span>
                  <span className="font-mono font-medium tabular-nums">{formatValue(Number(value), series?.format, series?.unit)}</span>
                </div>
              )}
            />
          }
        />
        <Pie data={slices} dataKey="value" nameKey="key" innerRadius={donut ? "55%" : 0} strokeWidth={2} isAnimationActive={false} />
        <ChartLegend content={<ChartLegendContent nameKey="key" />} className="flex-wrap" />
      </PieChart>
    </ChartContainer>
  );
}
