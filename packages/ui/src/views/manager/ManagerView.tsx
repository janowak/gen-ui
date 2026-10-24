import { Loader2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
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
  /** The environment previews, theme and recipes show for this person. */
  environment: string;
  environments: string[];
  components: Component[];
}

const isState = (value: unknown): value is State =>
  Boolean(value && typeof value === "object" && Array.isArray((value as State).components) && Array.isArray((value as State).environments));

/** The version each environment serves. CI publishes; the only action here is picking the environment this person looks at. */
export function ManagerView() {
  const { app, connectError, result } = useView("manager");
  const [state, setState] = useState<State>();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => {
    if (isState(result?.structured)) setState(result.structured);
  }, [result]);

  if (connectError) return <p className="p-3 text-sm text-destructive">Could not connect to the host: {connectError.message}</p>;
  if (result?.isError) return <p className="p-3 text-sm text-destructive">{result.text}</p>;

  async function use(environment: string) {
    if (!app) return;
    setBusy(environment);
    setMessage(null);
    const outcome = await callTool(app, "use_environment", { name: environment });
    setBusy(null);
    if (isState(outcome.data)) setState(outcome.data);
    setMessage({ text: outcome.text, error: outcome.isError });
    if (!outcome.isError) await app.updateModelContext({ content: [{ type: "text", text: `The user switched to ${environment}: ${outcome.text}` }] }).catch(() => {});
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Components</CardTitle>
        <CardDescription>
          The version each environment serves. CI publishes to environments; previews, theme and recipes here show {state?.environment ?? "prod"}.
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
            {state.components.length === 0 ? (
              <p className="text-sm text-muted-foreground">No components yet. Publish one with `genui publish --env {state.environment}`.</p>
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
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {state.components.map((c) => (
                    <TableRow key={c.name}>
                      <TableCell className="font-medium">{c.name}</TableCell>
                      {state.environments.map((environment) => (
                        <TableCell key={environment}>
                          {c.environments[environment] ? (
                            <Badge variant={environment === state.environment ? "default" : "secondary"}>{c.environments[environment]}</Badge>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                      ))}
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
