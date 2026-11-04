import { EyeIcon, KeyRoundIcon, Loader2Icon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useView } from "@/runtime/useView";
import { Choice, Copyable, pending, Status, useActions, useWorkspaceState, type Scope } from "./shared";

interface Token {
  id: string;
  name: string;
  scope: Scope;
  environments: string[] | null;
  createdAt: string;
  /** False until someone reveals its secret: until then it authenticates nothing. */
  revealed: boolean;
}

interface State {
  tokens: Token[];
  connectors: { environment: string; url: string }[];
  /** The token the model just created. */
  highlight?: string;
  /** From token_reveal and token_rotate only, which only this view can call: the one time a secret is shown. */
  secret?: { id: string; token: string };
}

const isState = (value: unknown): value is State =>
  Boolean(value && typeof value === "object" && Array.isArray((value as State).tokens) && Array.isArray((value as State).connectors));

/** How long a revealed secret stays on screen, and how long after it's copied. */
const SHOWN_MS = 60_000;
const AFTER_COPY_MS = 5_000;

/**
 * A revealed secret, shown once. It lives only in this component's memory: never in the view's saved state or
 * the model's context, and it's gone after copying or a minute. Reopening the chat shows the token as revealed.
 */
function Secret({
  token,
  secret,
  connectors,
  onHide,
}: {
  token: Token;
  secret: string;
  connectors: State["connectors"];
  onHide: () => void;
}) {
  const [hideIn, setHideIn] = useState(SHOWN_MS);
  // The latest onHide, so a re-render of the list doesn't restart the countdown.
  const hide = useRef(onHide);
  hide.current = onHide;
  useEffect(() => {
    const timer = setTimeout(() => hide.current(), hideIn);
    return () => clearTimeout(timer);
  }, [hideIn]);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-primary/40 p-3">
      <p className="text-sm">
        Secret of <b>{token.name}</b> ({token.scope}). Copy it now: it isn't shown again.
      </p>
      <Copyable value={secret} label={`Secret of ${token.name}`} onCopied={() => setHideIn(AFTER_COPY_MS)} />
      {token.scope === "server" ? (
        <p className="text-xs text-muted-foreground">
          In your server's environment: <code>APP_MCP_MCP_TOKEN</code> = this secret, <code>APP_MCP_MCP_URL</code> ={" "}
          {connectors.map((c, i) => (
            <span key={c.environment}>
              {i > 0 && " or "}
              <code>{c.url}</code> ({c.environment})
            </span>
          ))}
          .
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Use it as <code>APP_MCP_TOKEN</code>: <code>APP_MCP_TOKEN=… npx app-mcp publish</code>.
        </p>
      )}
      <Button size="sm" variant="outline" className="self-start" onClick={onHide}>
        Hide
      </Button>
    </div>
  );
}

/**
 * Tokens. The model can create and revoke them, but a secret is made and shown only here, on a click:
 * Reveal for a new token, Rotate for one already revealed.
 */
export function TokensView() {
  const view = useView("tokens");
  const [state, setState] = useWorkspaceState(view, isState);
  const { busy, message, run } = useActions(view.app);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ id: string; token: string }>();
  const [draft, setDraft] = useState<{ name: string; scope: Scope }>({ name: "", scope: "server" });
  const waiting = pending(view, state);
  if (waiting || !state) return waiting;

  async function act(key: string, tool: string, args: Record<string, unknown>, note: string) {
    const outcome = await run(key, tool, args, note);
    setConfirm(null);
    if (outcome && isState(outcome.data)) {
      const { secret: shown, ...rest } = outcome.data;
      setState(rest);
      if (shown) setSecret(shown);
    }
    return outcome;
  }
  const confirmed = (key: string, then: () => void) => (confirm === key ? then() : setConfirm(key));
  const shownToken = secret && state.tokens.find((t) => t.id === secret.id);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tokens</CardTitle>
        <CardDescription>
          <b>server</b>: your MCP server forwards app-mcp's tools with @app-mcp/sdk. <b>publish</b>: CI runs <code>app-mcp publish</code>.{" "}
          <b>admin</b>: every app-mcp CLI command. Secrets are shown once, here only.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {shownToken && secret && (
          <Secret token={shownToken} secret={secret.token} connectors={state.connectors} onHide={() => setSecret(undefined)} />
        )}
        {state.tokens.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.tokens.map((t) => (
                <TableRow key={t.id} className={t.id === state.highlight ? "bg-primary/5" : undefined}>
                  <TableCell className="font-medium">
                    {t.name}
                    {!t.revealed && <div className="text-xs font-normal text-muted-foreground">not revealed yet</div>}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{t.scope}</Badge>
                    {t.environments && <span className="ml-1 text-xs text-muted-foreground">{t.environments.join(", ")}</span>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{t.createdAt.slice(0, 10)}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      {t.revealed ? (
                        <Button
                          size="sm"
                          variant={confirm === `rotate:${t.id}` ? "destructive" : "outline"}
                          disabled={busy !== null}
                          onClick={() =>
                            confirmed(`rotate:${t.id}`, () =>
                              act(`rotate:${t.id}`, "token_rotate", { id: t.id }, "The user rotated a token"),
                            )
                          }
                        >
                          {busy === `rotate:${t.id}` ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
                          {confirm === `rotate:${t.id}` ? "Confirm rotate" : "Rotate"}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          disabled={busy !== null}
                          onClick={() => act(`reveal:${t.id}`, "token_reveal", { id: t.id }, "The user revealed a token")}
                        >
                          {busy === `reveal:${t.id}` ? <Loader2Icon className="animate-spin" /> : <EyeIcon />}
                          Reveal
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant={confirm === `revoke:${t.id}` ? "destructive" : "outline"}
                        disabled={busy !== null}
                        aria-label={`Revoke ${t.name}`}
                        onClick={() =>
                          confirmed(`revoke:${t.id}`, () => act(`revoke:${t.id}`, "token_revoke", { id: t.id }, "The user revoked a token"))
                        }
                      >
                        {busy === `revoke:${t.id}` ? <Loader2Icon className="animate-spin" /> : <Trash2Icon />}
                        {confirm === `revoke:${t.id}` ? "Confirm revoke" : null}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">No tokens yet.</p>
        )}
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={async (event) => {
            event.preventDefault();
            const outcome = await act("create", "token_create", draft, "The user created a token");
            if (outcome && !outcome.isError) setDraft({ name: "", scope: "server" });
          }}
        >
          <Input
            required
            maxLength={80}
            placeholder="e.g. production server"
            aria-label="Token name"
            className="w-56 flex-1"
            value={draft.name}
            onInput={(event) => setDraft({ ...draft, name: (event.target as HTMLInputElement).value })}
          />
          <Choice
            label="Scope"
            value={draft.scope}
            options={["server", "publish", "admin"]}
            onChange={(scope) => setDraft({ ...draft, scope })}
            disabled={busy !== null}
          />
          <Button type="submit" size="sm" variant="outline" disabled={busy !== null || !draft.name}>
            {busy === "create" ? <Loader2Icon className="animate-spin" /> : <KeyRoundIcon />}
            Create
          </Button>
        </form>
        <Status message={message} />
      </CardContent>
    </Card>
  );
}
