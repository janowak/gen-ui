import type { ChartType, SeriesData, ValueFormat } from "@app-mcp/format";
import { areaY, barX, barY, defineChart, group, lineY, ruleY, stack } from "@tanstack/charts";
import { decorative } from "@tanstack/charts/mark/decorative";
import { d3Curve } from "@tanstack/charts/d3/shape";
import { pie, polar, radialArc } from "@tanstack/charts/polar";
import { Chart as PreactChart, type ChartProps } from "@tanstack/charts/preact";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { scalePoint } from "@tanstack/charts/scales/point";
import { tooltip } from "@tanstack/charts/tooltip";
import { curveMonotoneX } from "d3-shape";
import { useMemo } from "react";
import { cn } from "@/lib/utils";

/** shadcn defines --chart-1..5. */
const PALETTE_SIZE = 5;
const color = (i: number) => `var(--chart-${(i % PALETTE_SIZE) + 1})`;
const HEIGHT = 256;
const monotone = d3Curve(curveMonotoneX);

/** The adapter is typed against Preact's JSX; this package type-checks JSX against React's. */
const Chart = PreactChart as unknown as <TDatum>(props: ChartProps<TDatum>) => React.ReactNode;

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

/** One row per (category, series): the long format TanStack marks consume. */
interface Row {
  category: string;
  series: string;
  value: number;
}

interface LegendItem {
  label: string;
  color: string;
}

interface Props {
  type: ChartType;
  data: SeriesData;
  stacked?: boolean;
  horizontal?: boolean;
}

export function ChartRenderer({ type, data, stacked, horizontal }: Props) {
  if (type === "pie" || type === "donut") return <PieRenderer data={data} donut={type === "donut"} />;
  return <CartesianRenderer type={type} data={data} stacked={stacked} horizontal={horizontal} />;
}

function CartesianRenderer({ type, data, stacked, horizontal }: Props) {
  const definition = useMemo(() => {
    const rows: Row[] = data.series.flatMap((s) =>
      data.categories.map((category, i) => ({ category, series: s.key, value: s.values[i] ?? Number.NaN })),
    );
    const first = data.series[0];
    const valueAxis = {
      scale: scaleLinear,
      nice: true,
      grid: { strokeOpacity: 1, stroke: "var(--border)" },
      axis: { line: false, ticks: { size: 0, padding: 8, format: (v: number) => formatValue(v, first?.format, first?.unit, true) } },
    };
    const categoryAxis = { axis: { line: false, ticks: { size: 0, padding: 8 } } };
    // An invisible rule at 0 keeps zero in the value domain, as recharts did.
    const zero = ruleY([0], { strokeOpacity: 0 });
    const colorScale = { domain: data.series.map((s) => s.key), range: data.series.map((_, i) => color(i)) };
    const layout = stacked ? stack() : group({ padding: 0.1 });
    const interaction = { maxFocusDistance: Number.POSITIVE_INFINITY, tooltip } as const;

    if (type === "bar" && horizontal) {
      return defineChart({
        marks: [barX(rows, { y: "category", x: "value", color: "series", layout, radius: stacked ? 0 : 4 })],
        scales: { y: { scale: () => scaleBand<string>().padding(0.2), ...categoryAxis }, x: valueAxis },
        color: colorScale,
        focus: "group-y",
        ...interaction,
      });
    }
    if (type === "bar") {
      return defineChart({
        marks: [barY(rows, { x: "category", y: "value", color: "series", layout, radius: stacked ? 0 : 4 })],
        scales: { x: { scale: () => scaleBand<string>().padding(0.2), ...categoryAxis }, y: valueAxis },
        color: colorScale,
        focus: "group-x",
        ...interaction,
      });
    }
    const x = { scale: () => scalePoint<string>().padding(0.1), ...categoryAxis };
    if (type === "area") {
      return defineChart({
        marks: [
          areaY(rows, {
            x: "category",
            y: "value",
            color: "series",
            curve: monotone,
            fillOpacity: 0.3,
            ...(stacked ? { layout: stack() } : { y1: 0 }),
          }),
          // Areas paint no outline; draw each series' top edge, at its stacked height when stacked.
          decorative(
            lineY(stacked ? stackedTops(data) : rows, {
              x: "category",
              y: "value",
              z: "series",
              color: "series",
              curve: monotone,
              strokeWidth: 1.5,
            }),
          ),
          zero,
        ],
        scales: { x, y: valueAxis },
        color: colorScale,
        focus: "group-x",
        ...interaction,
      });
    }
    return defineChart({
      marks: [lineY(rows, { x: "category", y: "value", z: "series", color: "series", curve: monotone, strokeWidth: 2 }), zero],
      scales: { x, y: valueAxis },
      color: colorScale,
      focus: "group-x",
      ...interaction,
    });
  }, [type, data, stacked, horizontal]);

  const series = (key: unknown) => data.series.find((s) => s.key === key);
  return (
    <ChartFrame legend={data.series.length > 1 ? data.series.map((s, i) => ({ label: s.name, color: color(i) })) : []}>
      <Chart
        definition={definition}
        ariaLabel={data.series.map((s) => s.name).join(", ")}
        height={HEIGHT}
        renderTooltipBody={({ points }) => (
          <TooltipBody
            title={String(points[0]?.datum && (points[0].datum as Row).category)}
            items={points.map((p) => {
              const row = p.datum as Row;
              const s = series(row.series);
              return { label: s?.name ?? row.series, color: p.color, value: formatValue(row.value, s?.format, s?.unit) };
            })}
          />
        )}
      />
    </ChartFrame>
  );
}

/** Each series' running total per category: the top edge of a stacked area. */
function stackedTops(data: SeriesData): Row[] {
  const totals = data.categories.map(() => 0);
  return data.series.flatMap((s) =>
    data.categories.map((category, i) => {
      totals[i]! += s.values[i] ?? 0;
      return { category, series: s.key, value: totals[i]! };
    }),
  );
}

/** Pie and donut plot the first series, one slice per category. */
function PieRenderer({ data, donut }: { data: SeriesData; donut: boolean }) {
  const series = data.series[0];
  const definition = useMemo(() => {
    const rows = data.categories.map((name, i) => ({ name, value: Math.max(0, series?.values[i] ?? 0) }));
    return defineChart({
      marks: [
        polar({
          inset: 4,
          marks: [
            radialArc(pie(rows, { value: "value" }), {
              innerRadius: donut ? ({ radius }) => radius * 0.55 : 0,
              color: "name",
              key: "name",
              stroke: "var(--card)",
              strokeWidth: 2,
            }),
          ],
          scales: { angle: null, radius: null },
        }),
      ],
      scales: { x: null, y: null },
      color: { domain: data.categories, range: data.categories.map((_, i) => color(i)) },
      tooltip,
    });
  }, [data, series, donut]);

  return (
    <ChartFrame legend={data.categories.map((label, i) => ({ label, color: color(i) }))} square>
      <Chart
        definition={definition}
        ariaLabel={series?.name ?? "Chart"}
        height={HEIGHT}
        renderTooltipBody={({ points }) => (
          <TooltipBody
            items={points.map((p) => {
              const slice = p.datum as { name: string; value: number };
              return { label: slice.name, color: p.color, value: formatValue(slice.value, series?.format, series?.unit) };
            })}
          />
        )}
      />
    </ChartFrame>
  );
}

function ChartFrame({ legend, square, children }: { legend: LegendItem[]; square?: boolean; children: React.ReactNode }) {
  return (
    <div className={cn("app-chart flex w-full flex-col gap-3 text-xs text-muted-foreground", square && "mx-auto max-w-64")}>
      {children}
      {legend.length > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
          {legend.map((item) => (
            <div key={item.label} className="flex items-center gap-1.5">
              <span className="size-2 shrink-0 rounded-[2px]" style={{ backgroundColor: item.color }} />
              <span className="text-foreground">{item.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TooltipBody({ title, items }: { title?: string; items: { label: string; color: string; value: string }[] }) {
  return (
    <div className="grid min-w-32 gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      {title && <div className="font-medium text-foreground">{title}</div>}
      {items.map((item) => (
        <div key={item.label} className="flex w-full items-center gap-2">
          <span className="size-2.5 shrink-0 rounded-[2px]" style={{ backgroundColor: item.color }} />
          <div className="flex flex-1 justify-between gap-4">
            <span className="text-muted-foreground">{item.label}</span>
            <span className="font-mono font-medium tabular-nums text-foreground">{item.value}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
