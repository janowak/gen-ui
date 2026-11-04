import { ChartSpec, ChartType, SeriesMapping, inlineSeries, rowsToSeries, type SeriesData } from "@app-mcp/format";
import { Loader2Icon, RotateCwIcon } from "lucide-react";
import { useMemo, useRef } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toolsReady, useView } from "@/runtime/useView";
import { ChartRenderer } from "./ChartRenderer";
import { useSourceData } from "./useSourceData";

/** While the model streams inline rows, draw the rows that are complete (the last one may be truncated). */
function partialChart(input: Record<string, unknown> | undefined): { type?: ChartType; title?: string; data: SeriesData | null } {
  const type = ChartType.safeParse(input?.type);
  const title = typeof input?.title === "string" ? input.title : undefined;
  const series = SeriesMapping.array().safeParse(input?.series);
  const rows = (input?.data as { rows?: unknown } | undefined)?.rows;
  if (!type.success || !series.success || !Array.isArray(rows) || rows.length < 2) return { type: type.data, title, data: null };
  const complete = rows.slice(0, -1).filter((r) => r && typeof r === "object");
  return { type: type.data, title, data: rowsToSeries(complete, { x: input?.x as string | undefined, series: series.data }) };
}

export function ChartView() {
  const { app, connectError, input, streaming, result, cancelled } = useView("chart");
  const containerRef = useRef<HTMLDivElement>(null);
  const parsed = useMemo(() => (input && !streaming ? ChartSpec.safeParse(input) : undefined), [input, streaming]);
  const spec = parsed?.success ? parsed.data : undefined;

  const isSource = Boolean(spec && "source" in spec.data);
  const sourceTool = spec && "source" in spec.data ? spec.data.source.toolName : undefined;
  const sourceReady = Boolean(sourceTool && toolsReady(result));
  const source = useSourceData(app, spec, sourceReady, containerRef);
  const inline = useMemo(() => (spec ? inlineSeries(spec) : null), [spec]);
  const partial = useMemo(() => (spec ? null : partialChart(input)), [spec, input]);

  if (connectError) return <Notice tone="error">Could not connect to the host: {connectError.message}</Notice>;
  if (cancelled) return <Notice>Chart cancelled.</Notice>;
  if (result?.isError) return <Notice tone="error">{result.text || "This chart could not be shown."}</Notice>;
  if (parsed && !parsed.success) return <Notice tone="error">Invalid chart definition.</Notice>;

  const type = spec?.type ?? partial?.type;
  const title = spec?.title ?? partial?.title;
  const data = spec ? (isSource ? source.data : inline) : (partial?.data ?? null);

  return (
    <Card ref={containerRef} className="gap-4">
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div className="flex flex-col gap-1.5">
          {title ? <CardTitle>{title}</CardTitle> : <Skeleton className="h-5 w-40" />}
          {spec?.description && <CardDescription>{spec.description}</CardDescription>}
        </div>
        {isSource && source.data && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground" title={source.updatedAt?.toLocaleString()}>
            {source.loading ? <Loader2Icon className="size-3 animate-spin" /> : <RotateCwIcon className="size-3" />}
            {source.updatedAt?.toLocaleTimeString()}
          </span>
        )}
      </CardHeader>
      <CardContent>
        {source.error && !source.data ? (
          <p className="text-sm text-destructive">{source.error}</p>
        ) : type && data && data.categories.length > 0 ? (
          <ChartRenderer type={type} data={data} stacked={spec?.stacked} horizontal={spec?.horizontal} />
        ) : spec && !isSource && data && data.categories.length === 0 ? (
          <p className="text-sm text-muted-foreground">No data.</p>
        ) : (
          <Skeleton className="h-64 w-full" />
        )}
      </CardContent>
    </Card>
  );
}

function Notice({ children, tone }: { children: React.ReactNode; tone?: "error" }) {
  return <p className={tone === "error" ? "p-3 text-sm text-destructive" : "p-3 text-sm text-muted-foreground"}>{children}</p>;
}
