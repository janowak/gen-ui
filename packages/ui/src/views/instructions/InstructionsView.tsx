import { MAX_ENVIRONMENT_INSTRUCTIONS } from "@genui/format";
import { Loader2Icon, SaveIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { callTool } from "@/runtime/tools";
import { useView } from "@/runtime/useView";

type Role = "member" | "admin";

/** `environment`: where the instructions live; a save goes there. `served`: what hosts get, workflows added. */
interface State {
  mode: "view" | "draft";
  role: Role;
  environment: string;
  instructions: string | null;
  served: string | null;
  limit: number;
  saved?: boolean;
}

function parseState(value: unknown): State | undefined {
  const v = value as Partial<State> | undefined;
  if (v?.mode !== "view" && v?.mode !== "draft") return undefined;
  return {
    mode: v.mode,
    role: v.role ?? "member",
    environment: v.environment ?? "prod",
    instructions: typeof v.instructions === "string" ? v.instructions : null,
    served: typeof v.served === "string" ? v.served : null,
    limit: typeof v.limit === "number" ? v.limit : 8000,
    saved: v.saved,
  };
}

/** One environment's MCP instructions. Admins edit them here and save with a click (app-only tool); workflows are added after them. */
export function InstructionsView() {
  const { app, connectError, result } = useView("instructions");
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

  async function save() {
    if (!app || !state) return;
    setBusy(true);
    setMessage(null);
    const outcome = await callTool(app, "instructions_save", { instructions: state.instructions?.trim() || null, environment: state.environment });
    setBusy(false);
    const next = parseState(outcome.data);
    if (next) {
      setState(next);
      setEdited(false);
    }
    setMessage({ text: outcome.text, error: outcome.isError });
    if (!outcome.isError) await app.updateModelContext({ content: [{ type: "text", text: `The user saved the instructions: ${outcome.text}` }] }).catch(() => {});
  }

  const pending = state.mode === "draft" || edited;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Instructions <Badge variant="outline">{state.environment}</Badge>
          {pending && !state.saved && <Badge variant="secondary">{state.mode === "draft" ? "draft" : "edited"}</Badge>}
        </CardTitle>
        <CardDescription>What the AI is told when someone adds this connector. Workflows without params are added after it.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <section className="flex flex-col gap-2">
          {isAdmin ? (
            <Textarea
              rows={6}
              maxLength={MAX_ENVIRONMENT_INSTRUCTIONS}
              aria-label="Instructions"
              placeholder="e.g. This connector handles returns and warranty claims for Acme. Look orders up with get_order before asking the user."
              value={state.instructions ?? ""}
              onInput={(event) => {
                setState({ ...state, instructions: (event.target as HTMLTextAreaElement).value, saved: false });
                setEdited(true);
              }}
            />
          ) : (
            <p className="text-sm whitespace-pre-wrap text-muted-foreground">{state.instructions || "None yet."}</p>
          )}
          {isAdmin && (
            <p className="text-xs text-muted-foreground">
              {(state.instructions ?? "").length} / {MAX_ENVIRONMENT_INSTRUCTIONS}. Hosts add the instructions to every conversation that uses the connector, so keep them short.
            </p>
          )}
        </section>

        {state.served && (
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">
              What hosts get{" "}
              <span className="font-normal text-muted-foreground">
                ({state.served.length} / {state.limit}
                {pending && !state.saved ? ", as last saved" : ""})
              </span>
            </h3>
            <pre className="max-h-64 overflow-auto rounded-lg border p-3 text-xs whitespace-pre-wrap text-muted-foreground">{state.served}</pre>
          </section>
        )}
      </CardContent>
      <CardFooter className="flex flex-wrap items-center gap-2">
        {isAdmin ? (
          <Button disabled={busy || !pending || state.saved} onClick={save}>
            {busy ? <Loader2Icon className="animate-spin" /> : <SaveIcon />}
            {state.saved ? `Saved to ${state.environment}` : `Save to ${state.environment}`}
          </Button>
        ) : (
          <span className="text-sm text-muted-foreground">Only admins can change these.</span>
        )}
        {message && <span className={message.error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>{message.text}</span>}
      </CardFooter>
    </Card>
  );
}
