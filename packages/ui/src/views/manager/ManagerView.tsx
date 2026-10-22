import { ArrowUpIcon, Loader2Icon, Undo2Icon } from "lucide-react";
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
  channels: { beta?: string; stable?: string };
  versions: string[];
}

interface State {
  role: "member" | "admin";
  components: Component[];
}

const isState = (value: unknown): value is State => Boolean(value && typeof value === "object" && Array.isArray((value as State).components));

/** Registry component list with beta/stable channels. Admin actions run only on a click (app-only tools). */
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

  async function run(key: string, tool: string, args: Record<string, unknown>) {
    if (!app) return;
    setBusy(key);
    setMessage(null);
    const outcome = await callTool(app, tool, args);
    setBusy(null);
    if (isState(outcome.data)) setState(outcome.data);
    setMessage({ text: outcome.text, error: outcome.isError });
    if (!outcome.isError) await app.updateModelContext({ content: [{ type: "text", text: `The user ran ${tool}: ${outcome.text}` }] }).catch(() => {});
  }

  const isAdmin = state?.role === "admin";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Components</CardTitle>
        <CardDescription>
          {isAdmin ? "Promote beta to stable, or roll stable back." : "You can browse components. Ask an admin to promote or roll back."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!state ? (
          <Skeleton className="h-24 w-full" />
        ) : state.components.length === 0 ? (
          <p className="text-sm text-muted-foreground">No components yet. Publish one with `genui publish`.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Component</TableHead>
                <TableHead>Stable</TableHead>
                <TableHead>Beta</TableHead>
                {isAdmin && <TableHead className="text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.components.map((c) => {
                const pending = c.channels.beta && c.channels.beta !== c.channels.stable;
                return (
                  <TableRow key={c.name}>
                    <TableCell className="font-medium">{c.name}</TableCell>
                    <TableCell>{c.channels.stable ? <Badge variant="secondary">{c.channels.stable}</Badge> : "—"}</TableCell>
                    <TableCell>{c.channels.beta ? <Badge variant={pending ? "default" : "outline"}>{c.channels.beta}</Badge> : "—"}</TableCell>
                    {isAdmin && (
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button size="sm" disabled={!pending || busy !== null} onClick={() => run(`${c.name}:promote`, "component_promote", { name: c.name })}>
                            {busy === `${c.name}:promote` ? <Loader2Icon className="animate-spin" /> : <ArrowUpIcon />}
                            Promote
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!c.channels.stable || busy !== null}
                            onClick={() => run(`${c.name}:rollback`, "component_rollback", { name: c.name, channel: "stable" })}
                          >
                            {busy === `${c.name}:rollback` ? <Loader2Icon className="animate-spin" /> : <Undo2Icon />}
                            Roll back
                          </Button>
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
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
