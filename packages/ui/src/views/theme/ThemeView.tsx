import { Theme, type ThemeTokens } from "@genui/format";
import { Loader2Icon, Maximize2Icon, RotateCcwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { applyTheme } from "@/runtime/theme";
import { callTool } from "@/runtime/tools";
import { useView } from "@/runtime/useView";
import { ChartRenderer } from "@/views/chart/ChartRenderer";

type Mode = "light" | "dark";

const TOKENS: { key: keyof Omit<ThemeTokens, "chart">; label: string }[] = [
  { key: "primary", label: "Primary" },
  { key: "primaryForeground", label: "Primary text" },
  { key: "accent", label: "Accent" },
  { key: "accentForeground", label: "Accent text" },
];

const RADII = ["0rem", "0.375rem", "0.625rem", "0.875rem"];

const SAMPLE = {
  categories: ["Jan", "Feb", "Mar", "Apr", "May"],
  series: [
    { key: "s0", name: "Revenue", values: [42, 48, 51, 55, 61] },
    { key: "s1", name: "Costs", values: [30, 33, 32, 36, 38] },
    { key: "s2", name: "Target", values: [45, 47, 50, 53, 56] },
  ],
};

/** A hex value for <input type="color">, which only accepts #rrggbb. */
const asHex = (value: string | undefined) => (value && /^#[0-9a-f]{6}$/i.test(value) ? value : "#000000");

function ColorField({
  id,
  label,
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value?: string;
  disabled: boolean;
  onChange: (v: string | undefined) => void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="flex gap-2">
        <input
          type="color"
          aria-label={`${label} color`}
          className="size-8 shrink-0 cursor-pointer rounded-md border border-input bg-transparent p-0.5 disabled:cursor-default"
          value={asHex(value)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
        <Input
          id={id}
          value={value ?? ""}
          placeholder="host default"
          disabled={disabled}
          onChange={(e) => onChange(e.target.value || undefined)}
        />
      </div>
    </Field>
  );
}

/** One environment's theme editor with a live preview. Saving uses the app-only theme_save tool (admins). */
export function ThemeView() {
  const { app, connectError, result, hostContext } = useView("theme");
  const [saved, setSaved] = useState<Theme>({});
  const [draft, setDraft] = useState<Theme>({});
  const [mode, setMode] = useState<Mode>("light");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [environment, setEnvironment] = useState("prod");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => {
    const data = result?.structured as { role?: "member" | "admin"; environment?: string; theme?: unknown } | undefined;
    if (!data) return;
    setEnvironment(data.environment ?? "prod");
    const theme = Theme.safeParse(data.theme ?? {});
    setSaved(theme.success ? theme.data : {});
    setDraft(theme.success ? theme.data : {});
    setRole(data.role === "admin" ? "admin" : "member");
  }, [result]);

  // Preview the draft in the selected mode. Re-applied whenever useView re-applies the host theme
  // (it depends on the same host context and result), so the draft always wins.
  const hostVariables = hostContext?.styles?.variables;
  useEffect(() => applyTheme({ mode, hostVariables, workspace: draft }), [mode, hostVariables, draft, hostContext, result]);
  useEffect(() => {
    if (hostContext?.theme) setMode(hostContext.theme === "dark" ? "dark" : "light");
  }, [hostContext?.theme]);

  if (connectError) return <p className="p-3 text-sm text-destructive">Could not connect to the host: {connectError.message}</p>;

  const canEdit = role === "admin";
  const tokens = draft[mode] ?? {};
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const canFullscreen = hostContext?.availableDisplayModes?.includes("fullscreen") && hostContext.displayMode !== "fullscreen";

  const setToken = (key: keyof ThemeTokens, value: string | string[] | undefined) =>
    setDraft((d) => ({ ...d, [mode]: { ...d[mode], [key]: value } }));
  const setChart = (index: number, value: string | undefined) => {
    const chart = [...(tokens.chart ?? [])];
    chart[index] = value ?? "";
    setToken("chart", chart.some(Boolean) ? chart.map((c) => c || "#888888") : undefined);
  };

  async function save() {
    if (!app) return;
    setSaving(true);
    setMessage(null);
    const outcome = await callTool(app, "theme_save", { theme: draft, environment });
    setSaving(false);
    setMessage({ text: outcome.text, error: outcome.isError });
    if (!outcome.isError) {
      setSaved(draft);
      await app
        .updateModelContext({ content: [{ type: "text", text: `The user saved the ${environment} theme: ${JSON.stringify(draft)}` }] })
        .catch(() => {});
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div className="flex flex-col gap-1.5">
          <CardTitle className="flex items-center gap-2">
            Theme <Badge variant="outline">{environment}</Badge>
          </CardTitle>
          <CardDescription>
            {canEdit ? "Unset values follow the host (Claude, ChatGPT…)." : "Read-only: ask an admin to change the theme."}
          </CardDescription>
        </div>
        {canFullscreen && app && (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Expand"
            onClick={() => app.requestDisplayMode({ mode: "fullscreen" }).catch(() => {})}
          >
            <Maximize2Icon />
          </Button>
        )}
      </CardHeader>
      <CardContent className="grid gap-6 md:grid-cols-2">
        <FieldGroup>
          <Tabs value={mode} onValueChange={(value) => setMode(value as Mode)}>
            <TabsList>
              <TabsTrigger value="light">Light</TabsTrigger>
              <TabsTrigger value="dark">Dark</TabsTrigger>
            </TabsList>
          </Tabs>
          {TOKENS.map(({ key, label }) => (
            <ColorField
              key={`${mode}-${key}`}
              id={`${mode}-${key}`}
              label={label}
              value={tokens[key]}
              disabled={!canEdit}
              onChange={(v) => setToken(key, v)}
            />
          ))}
          <Field>
            <FieldLabel>Chart palette</FieldLabel>
            <div className="flex gap-2">
              {Array.from({ length: 5 }, (_, i) => (
                <input
                  key={`${mode}-chart-${i}`}
                  type="color"
                  aria-label={`Chart color ${i + 1}`}
                  className="size-8 cursor-pointer rounded-md border border-input bg-transparent p-0.5 disabled:cursor-default"
                  value={asHex(tokens.chart?.[i])}
                  disabled={!canEdit}
                  onChange={(e) => setChart(i, e.target.value)}
                />
              ))}
            </div>
          </Field>
          <Field>
            <FieldLabel>Corner radius</FieldLabel>
            <Tabs value={draft.radius ?? ""} onValueChange={(value) => setDraft((d) => ({ ...d, radius: (value as string) || undefined }))}>
              <TabsList>
                <TabsTrigger value="" disabled={!canEdit}>
                  Host
                </TabsTrigger>
                {RADII.map((r) => (
                  <TabsTrigger key={r} value={r} disabled={!canEdit}>
                    {r.replace("rem", "")}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </Field>
        </FieldGroup>

        <div className="flex flex-col gap-4 rounded-lg border p-4" aria-label="Preview">
          <Field>
            <FieldLabel htmlFor="preview-name">Customer</FieldLabel>
            <Input id="preview-name" placeholder="Acme Corp" />
          </Field>
          <Field orientation="horizontal">
            <Checkbox id="preview-check" defaultChecked />
            <FieldLabel htmlFor="preview-check">Send confirmation</FieldLabel>
          </Field>
          <div className="flex gap-2">
            <Button>Submit</Button>
            <Button variant="secondary">Cancel</Button>
          </div>
          <ChartRenderer type="bar" data={SAMPLE} />
        </div>
      </CardContent>
      {canEdit && (
        <CardFooter className="flex items-center gap-2">
          <Button onClick={save} disabled={!dirty || saving}>
            {saving && <Loader2Icon className="animate-spin" />}
            Save to {environment}
          </Button>
          <Button variant="ghost" onClick={() => setDraft(saved)} disabled={!dirty || saving}>
            <RotateCcwIcon /> Reset
          </Button>
          {message && <span className={message.error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>{message.text}</span>}
        </CardFooter>
      )}
    </Card>
  );
}
