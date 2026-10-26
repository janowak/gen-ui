import { Loader2Icon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { callTool } from "@/runtime/tools";
import { useView } from "@/runtime/useView";

interface Component {
  name: string;
  environments: Record<string, string>;
  versions: string[];
}

interface State {
  role: "member" | "admin";
  /** The environment previews, theme, instructions and workflows show for this person. */
  environment: string;
  environments: string[];
  components: Component[];
  /** Whether the shown environment offers the built-in render_form and render_chart. */
  builtIns: boolean;
}

const isState = (value: unknown): value is State =>
  Boolean(value && typeof value === "object" && Array.isArray((value as State).components) && Array.isArray((value as State).environments));

/**
 * The version each environment serves. CI publishes; here a person picks the environment they look at, and
 * admins can stop serving a component or turn the built-in forms and charts off there (app-only tools).
 */
export function ManagerView() {
  const { app, connectError, result } = useView("manager");
  const [state, setState] = useState<State>();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => {
    if (isState(result?.structured)) setState(result.structured);
  }, [result]);

  if (connectError) return <p className="p-3 text-sm text-destructive">Could not connect to the host: {connectError.message}</p>;
  if (result?.isError) return <p className="p-3 text-sm text-destructive">{result.text}</p>;

  async function run(key: string, tool: string, args: Record<string, unknown>, note: string) {
    if (!app) return;
    setBusy(key);
    setMessage(null);
    const outcome = await callTool(app, tool, args);
    setBusy(null);
    setConfirm(null);
    if (isState(outcome.data)) setState(outcome.data);
    setMessage({ text: outcome.text, error: outcome.isError });
    if (!outcome.isError) await app.updateModelContext({ content: [{ type: "text", text: `${note}: ${outcome.text}` }] }).catch(() => {});
  }

  const use = (environment: string) => run(environment, "use_environment", { name: environment }, `The user switched to ${environment}`);
  const isAdmin = state?.role === "admin";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Components</CardTitle>
        <CardDescription>
          The version each environment serves. CI publishes to environments; previews, theme, instructions and workflows here show{" "}
          {state?.environment ?? "prod"}.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!state ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            {state.environments.length > 1 && (
              <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Environment">
                <span className="mr-1 text-sm text-muted-foreground">Show</span>
                {state.environments.map((environment) => (
                  <Button
                    key={environment}
                    size="sm"
                    variant={environment === state.environment ? "default" : "outline"}
                    aria-pressed={environment === state.environment}
                    disabled={busy !== null}
                    onClick={() => environment !== state.environment && use(environment)}
                  >
                    {busy === environment && <Loader2Icon className="animate-spin" />}
                    {environment}
                  </Button>
                ))}
              </div>
            )}
            <label className="flex items-center justify-between gap-2 text-sm">
              <span>
                Built-in forms and charts in {state.environment}
                <span className="block text-muted-foreground">render_form and render_chart, next to your components.</span>
              </span>
              {isAdmin ? (
                <Switch
                  checked={state.builtIns}
                  disabled={busy !== null}
                  onCheckedChange={(enabled: boolean) =>
                    run(
                      "builtIns",
                      "built_ins_set",
                      { enabled, environment: state.environment },
                      "The user changed the built-in forms and charts",
                    )
                  }
                />
              ) : (
                <Badge variant="outline">{state.builtIns ? "on" : "off"}</Badge>
              )}
            </label>
            {state.components.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No components yet. Publish one with `genui publish --env {state.environment}`.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Component</TableHead>
                    {state.environments.map((environment) => (
                      <TableHead key={environment} className={environment === state.environment ? "text-foreground" : undefined}>
                        {environment}
                      </TableHead>
                    ))}
                    {isAdmin && <TableHead className="sr-only">Actions</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {state.components.map((c) => (
                    <TableRow key={c.name}>
                      <TableCell className="font-medium">{c.name}</TableCell>
                      {state.environments.map((environment) => (
                        <TableCell key={environment}>
                          {c.environments[environment] ? (
                            <Badge variant={environment === state.environment ? "default" : "secondary"}>
                              {c.environments[environment]}
                            </Badge>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                      ))}
                      {isAdmin && (
                        <TableCell className="text-right">
                          {c.environments[state.environment] && (
                            <Button
                              size="sm"
                              variant={confirm === c.name ? "destructive" : "outline"}
                              disabled={busy !== null}
                              onClick={() =>
                                confirm === c.name
                                  ? run(
                                      c.name,
                                      "component_remove",
                                      { name: c.name, environment: state.environment },
                                      "The user stopped serving a component",
                                    )
                                  : setConfirm(c.name)
                              }
                            >
                              {busy === c.name ? <Loader2Icon className="animate-spin" /> : <Trash2Icon />}
                              {confirm === c.name ? `Remove from ${state.environment}` : "Remove"}
                            </Button>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </>
        )}
        {message && (
          <p role="status" className={message.error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
            {message.text}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
