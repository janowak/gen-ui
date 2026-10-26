import { Guide, MAX_INSTRUCTIONS, type WorkflowPrompt } from "@genui/format";
import { Loader2Icon, PlusIcon, SaveIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { callTool } from "@/runtime/tools";
import { useView } from "@/runtime/useView";

type Role = "member" | "admin";

/** `environment`: where the guide lives; a save goes there. `recipes`: names a prompt can't take. */
interface State {
  mode: "view" | "draft";
  role: Role;
  environment: string;
  instructions?: string;
  prompts: WorkflowPrompt[];
  recipes: string[];
  saved?: boolean;
}

function parseState(value: unknown): State | undefined {
  const v = value as Partial<State> | undefined;
  if (v?.mode !== "view" && v?.mode !== "draft") return undefined;
  const guide = Guide.safeParse({ instructions: v.instructions, prompts: v.prompts });
  if (!guide.success) return undefined;
  return {
    mode: v.mode,
    role: v.role ?? "member",
    environment: v.environment ?? "prod",
    ...guide.data,
    recipes: Array.isArray(v.recipes) ? v.recipes : [],
    saved: v.saved,
  };
}

const blank: WorkflowPrompt = { name: "", description: "", prompt: "" };

/** One environment's MCP instructions and workflow prompts. Admins edit them here and save with a click (app-only tool). */
export function GuideView() {
  const { app, connectError, result } = useView("guide");
  const [state, setState] = useState<State>();
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => {
    const next = parseState(result?.structured);
    if (next) setState(next);
  }, [result]);

  if (connectError) return <p className="p-3 text-sm text-destructive">Could not connect to the host: {connectError.message}</p>;
  if (result?.isError) return <p className="p-3 text-sm text-destructive">{result.text}</p>;
  if (!state) return <Skeleton className="m-px h-40 w-full" />;

  const isAdmin = state.role === "admin";
  const update = (patch: Partial<State>) => {
    setState({ ...state, ...patch, saved: false });
    setEdited(true);
  };
  const setPrompt = (index: number, patch: Partial<WorkflowPrompt>) => update({ prompts: state.prompts.map((p, i) => (i === index ? { ...p, ...patch } : p)) });

  const guide = { instructions: state.instructions?.trim() || undefined, prompts: state.prompts };
  const checked = Guide.safeParse(guide);
  const clash = state.prompts.find((p) => state.recipes.includes(p.name));
  const problem = clash ? `/${clash.name} is already a recipe.` : checked.success ? null : `${checked.error.issues[0].path.join(".")}: ${checked.error.issues[0].message}`;

  async function save() {
    if (!app || !state) return;
    setBusy(true);
    setMessage(null);
    const outcome = await callTool(app, "guide_save", { guide, environment: state.environment });
    setBusy(false);
    const next = parseState(outcome.data);
    if (next) {
      setState(next);
      setEdited(false);
    }
    setMessage({ text: outcome.text, error: outcome.isError });
    if (!outcome.isError) await app.updateModelContext({ content: [{ type: "text", text: `The user saved the instructions and workflow prompts: ${outcome.text}` }] }).catch(() => {});
  }

  const pending = state.mode === "draft" || edited;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Instructions and workflows <Badge variant="outline">{state.environment}</Badge>
          {pending && !state.saved && <Badge variant="secondary">{state.mode === "draft" ? "draft" : "edited"}</Badge>}
        </CardTitle>
        <CardDescription>What the AI is told when someone adds this connector, and slash commands that start a workflow.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Instructions</h3>
          {isAdmin ? (
            <Textarea
              rows={6}
              maxLength={MAX_INSTRUCTIONS}
              aria-label="Instructions"
              placeholder="e.g. This connector handles returns and warranty claims. For a return: ask for the order, then use the return_request recipe…"
              value={state.instructions ?? ""}
              onInput={(event) => update({ instructions: (event.target as HTMLTextAreaElement).value })}
            />
          ) : (
            <p className="text-sm whitespace-pre-wrap text-muted-foreground">{state.instructions || "None yet."}</p>
          )}
          {isAdmin && (
            <p className="text-xs text-muted-foreground">
              {(state.instructions ?? "").length} / {MAX_INSTRUCTIONS}. Hosts add these to every conversation that uses the connector, so keep them short.
            </p>
          )}
        </section>

        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-medium">Workflow prompts</h3>
          {state.prompts.length === 0 && <p className="text-sm text-muted-foreground">None yet. Ask to draft one, e.g. "make a workflow for returning an order".</p>}
          {state.prompts.map((p, i) =>
            isAdmin ? (
              <div key={i} className="flex flex-col gap-2 rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-muted-foreground">/</span>
                  <Input aria-label="Command name" placeholder="return_order" className="w-44" value={p.name} onInput={(e) => setPrompt(i, { name: (e.target as HTMLInputElement).value })} />
                  <Input
                    aria-label="Title"
                    placeholder="Title (optional)"
                    className="w-44 flex-1"
                    value={p.title ?? ""}
                    onInput={(e) => setPrompt(i, { title: (e.target as HTMLInputElement).value || undefined })}
                  />
                  <Button size="sm" variant="outline" aria-label={`Remove /${p.name}`} onClick={() => update({ prompts: state.prompts.filter((_, j) => j !== i) })}>
                    <Trash2Icon />
                  </Button>
                </div>
                <Input
                  aria-label="Description"
                  placeholder="What the workflow does"
                  value={p.description}
                  onInput={(e) => setPrompt(i, { description: (e.target as HTMLInputElement).value })}
                />
                <Textarea
                  rows={3}
                  aria-label="Prompt"
                  placeholder="The steps the AI follows, the recipes and tools to use"
                  value={p.prompt}
                  onInput={(e) => setPrompt(i, { prompt: (e.target as HTMLTextAreaElement).value })}
                />
              </div>
            ) : (
              <div key={i} className="flex flex-col gap-1">
                <p className="text-sm font-medium">
                  /{p.name}
                  {p.title && <span className="font-normal text-muted-foreground"> · {p.title}</span>}
                </p>
                <p className="text-sm text-muted-foreground">{p.description}</p>
              </div>
            ),
          )}
          {isAdmin && (
            <Button size="sm" variant="outline" className="self-start" onClick={() => update({ prompts: [...state.prompts, blank] })}>
              <PlusIcon />
              Add workflow prompt
            </Button>
          )}
        </section>
      </CardContent>
      <CardFooter className="flex flex-wrap items-center gap-2">
        {isAdmin ? (
          <Button disabled={busy || !pending || state.saved || problem !== null} onClick={save}>
            {busy ? <Loader2Icon className="animate-spin" /> : <SaveIcon />}
            {state.saved ? `Saved to ${state.environment}` : `Save to ${state.environment}`}
          </Button>
        ) : (
          <span className="text-sm text-muted-foreground">Only admins can change these.</span>
        )}
        {isAdmin && pending && problem && <span className="text-sm text-destructive">{problem}</span>}
        {message && <span className={message.error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>{message.text}</span>}
      </CardFooter>
    </Card>
  );
}
