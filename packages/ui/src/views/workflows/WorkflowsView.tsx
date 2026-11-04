import { isCommand, Workflow, type WorkflowParam } from "@app-mcp/format";
import { Loader2Icon, PencilIcon, PlusIcon, SaveIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { callTool } from "@/runtime/tools";
import { useView } from "@/runtime/useView";

type Role = "member" | "admin";
/** `environment`: where these workflows live; saves and deletes go there. */
type State =
  | { mode: "list"; role: Role; environment: string; workflows: Workflow[] }
  | { mode: "draft"; role: Role; environment: string; workflow: Workflow; replaces: boolean; saved?: boolean };

function parseState(value: unknown): State | undefined {
  const v = value as
    | { mode?: string; role?: Role; environment?: string; workflows?: unknown[]; workflow?: unknown; replaces?: boolean; saved?: boolean }
    | undefined;
  const base = { role: v?.role ?? "member", environment: v?.environment ?? "prod" };
  if (v?.mode === "list" && Array.isArray(v.workflows)) {
    return { mode: "list", ...base, workflows: v.workflows.flatMap((w) => (Workflow.safeParse(w).success ? [Workflow.parse(w)] : [])) };
  }
  if (v?.mode === "draft") {
    const workflow = Workflow.safeParse(v.workflow);
    if (workflow.success) return { mode: "draft", ...base, workflow: workflow.data, replaces: Boolean(v.replaces), saved: v.saved };
  }
  return undefined;
}

const blank: Workflow = { name: "", description: "", instructions: "", params: [] };
const blankParam: WorkflowParam = { name: "", description: "", required: false };

const value = (event: { target: EventTarget | null }) => (event.target as HTMLInputElement | HTMLTextAreaElement).value;

/**
 * One environment's workflows: list (edit, delete) and a draft editor (save). A workflow with params
 * is a slash command; without, it's part of the MCP instructions. Changes run only on a click (app-only tools).
 */
export function WorkflowsView() {
  const { app, connectError, result } = useView("workflows");
  const [state, setState] = useState<State>();
  /** The list to return to from an editor opened here. */
  const [list, setList] = useState<Extract<State, { mode: "list" }>>();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => {
    const next = parseState(result?.structured);
    if (next) setState(next);
  }, [result]);

  if (connectError) return <p className="p-3 text-sm text-destructive">Could not connect to the host: {connectError.message}</p>;
  if (result?.isError) return <p className="p-3 text-sm text-destructive">{result.text}</p>;
  if (!state) return <Skeleton className="m-px h-40 w-full" />;

  const isAdmin = state.role === "admin";

  async function run(key: string, tool: string, args: Record<string, unknown>, note: string) {
    if (!app) return;
    setBusy(key);
    setMessage(null);
    const outcome = await callTool(app, tool, args);
    setBusy(null);
    setConfirm(null);
    const next = parseState(outcome.data);
    if (next) setState(next);
    setMessage({ text: outcome.text, error: outcome.isError });
    if (!outcome.isError) await app.updateModelContext({ content: [{ type: "text", text: `${note}: ${outcome.text}` }] }).catch(() => {});
  }

  function edit(workflow: Workflow, replaces: boolean) {
    if (state?.mode === "list") setList(state);
    setMessage(null);
    setState({ mode: "draft", role: state!.role, environment: state!.environment, workflow, replaces });
  }

  if (state.mode === "draft") {
    const { workflow } = state;
    const change = (patch: Partial<Workflow>) => setState({ ...state, workflow: { ...workflow, ...patch }, saved: false });
    const setParam = (index: number, patch: Partial<WorkflowParam>) =>
      change({ params: workflow.params.map((p, i) => (i === index ? { ...p, ...patch } : p)) });
    const checked = Workflow.safeParse(workflow);
    const problem = checked.success ? null : `${checked.error.issues[0].path.join(".") || "workflow"}: ${checked.error.issues[0].message}`;
    const command = isCommand(workflow);

    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <span>Workflow {workflow.name && <code>{command ? `/${workflow.name}` : workflow.name}</code>}</span>
            <Badge variant="outline">{state.environment}</Badge>
            <Badge variant="secondary">{command ? "slash command" : "always on"}</Badge>
          </CardTitle>
          <CardDescription>
            {command
              ? "Users start it as a slash command and give the params; the AI then gets the instructions with their values."
              : "No params: the AI always has these instructions, as part of the MCP instructions."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {isAdmin ? (
            <>
              <div className="flex flex-wrap gap-2">
                <Input
                  aria-label="Name"
                  placeholder="return_order"
                  className="w-44"
                  value={workflow.name}
                  disabled={state.replaces}
                  onInput={(e) => change({ name: value(e) })}
                />
                <Input
                  aria-label="Title"
                  placeholder="Title (optional)"
                  className="w-44 flex-1"
                  value={workflow.title ?? ""}
                  onInput={(e) => change({ title: value(e) || undefined })}
                />
              </div>
              <Input
                aria-label="Description"
                placeholder="When to use it, e.g. The user wants to return an order."
                value={workflow.description}
                onInput={(e) => change({ description: value(e) })}
              />
              <Textarea
                rows={8}
                maxLength={4000}
                aria-label="Instructions"
                placeholder="The steps: what to ask, which tools to call (render_form, render_<component>, your server's tools), in order."
                value={workflow.instructions}
                onInput={(e) => change({ instructions: value(e) })}
              />
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">Params</h3>
                {workflow.params.length === 0 && (
                  <p className="text-sm text-muted-foreground">None: add one to make this a slash command.</p>
                )}
                {workflow.params.map((p, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <Input
                      aria-label="Param name"
                      placeholder="order_id"
                      className="w-36"
                      value={p.name}
                      onInput={(e) => setParam(i, { name: value(e) })}
                    />
                    <Input
                      aria-label="Param description"
                      placeholder="The order number"
                      className="w-44 flex-1"
                      value={p.description}
                      onInput={(e) => setParam(i, { description: value(e) })}
                    />
                    <label className="flex items-center gap-1 text-sm text-muted-foreground">
                      <Switch checked={p.required} onCheckedChange={(required) => setParam(i, { required })} aria-label="Required" />
                      required
                    </label>
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`Remove ${p.name}`}
                      onClick={() => change({ params: workflow.params.filter((_, j) => j !== i) })}
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                ))}
                <Button
                  size="sm"
                  variant="outline"
                  className="self-start"
                  onClick={() => change({ params: [...workflow.params, blankParam] })}
                >
                  <PlusIcon />
                  Add param
                </Button>
              </section>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">{workflow.description}</p>
              <p className="text-sm whitespace-pre-wrap">{workflow.instructions}</p>
              {command && (
                <p className="text-sm text-muted-foreground">
                  Params: {workflow.params.map((p) => `${p.name}${p.required ? "" : "?"}`).join(", ")}
                </p>
              )}
            </>
          )}
          {state.replaces && !state.saved && (
            <p className="text-sm text-muted-foreground">
              Saving replaces {workflow.name} in {state.environment}.
            </p>
          )}
        </CardContent>
        <CardFooter className="flex flex-wrap items-center gap-2">
          {isAdmin ? (
            <Button
              disabled={busy !== null || state.saved || problem !== null}
              onClick={() =>
                run("save", "workflow_save", { workflow: checked.data, environment: state.environment }, "The user saved a workflow")
              }
            >
              {busy === "save" ? <Loader2Icon className="animate-spin" /> : <SaveIcon />}
              {state.saved
                ? `Saved to ${state.environment}`
                : state.replaces
                  ? `Replace in ${state.environment}`
                  : `Save to ${state.environment}`}
            </Button>
          ) : (
            <span className="text-sm text-muted-foreground">Only admins can save workflows.</span>
          )}
          {list && (
            <Button variant="outline" disabled={busy !== null} onClick={() => setState(list)}>
              Back
            </Button>
          )}
          {isAdmin && problem && !state.saved && <span className="text-sm text-destructive">{problem}</span>}
          {message && <span className={message.error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>{message.text}</span>}
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Workflows <Badge variant="outline">{state.environment}</Badge>
        </CardTitle>
        <CardDescription>
          Playbooks the AI follows. With params a workflow is a slash command; without, the AI always has it.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {state.workflows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No workflows yet. Ask to draft one, e.g. "make a workflow for returning an order", or keep them in your repo and publish with
            genui publish.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Workflow</TableHead>
                <TableHead>When</TableHead>
                <TableHead>Starts as</TableHead>
                {isAdmin && <TableHead className="text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.workflows.map((w) => (
                <TableRow key={w.name}>
                  <TableCell className="font-medium">{isCommand(w) ? `/${w.name}` : w.name}</TableCell>
                  <TableCell className="max-w-64 truncate text-muted-foreground" title={w.description}>
                    {w.description}
                  </TableCell>
                  <TableCell>
                    {isCommand(w) ? <Badge variant="secondary">command</Badge> : <span className="text-muted-foreground">always on</span>}
                  </TableCell>
                  {isAdmin && (
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => edit(w, true)}>
                          <PencilIcon />
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant={confirm === w.name ? "destructive" : "outline"}
                          disabled={busy !== null}
                          onClick={() =>
                            confirm === w.name
                              ? run(
                                  w.name,
                                  "workflow_delete",
                                  { name: w.name, environment: state.environment },
                                  "The user deleted a workflow",
                                )
                              : setConfirm(w.name)
                          }
                        >
                          {busy === w.name ? <Loader2Icon className="animate-spin" /> : <Trash2Icon />}
                          {confirm === w.name ? "Confirm delete" : "Delete"}
                        </Button>
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {isAdmin && (
          <Button size="sm" variant="outline" className="self-start" onClick={() => edit(blank, false)}>
            <PlusIcon />
            New workflow
          </Button>
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
