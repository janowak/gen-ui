import { ImageIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useView } from "@/runtime/useView";
import { Copyable, pending, useWorkspaceState, type Role } from "./shared";

interface State {
  role: Role;
  workspace: { id: string; name: string };
  /** How hosts list the end-user MCP. */
  title: string;
  iconUrl: string | null;
  public: boolean;
  /** The end-user MCP address of each environment. */
  connectors: { environment: string; url: string }[];
  /** `tokens` for admins only. */
  counts: { members: number; invites: number; components: number; tokens?: number };
}

const isState = (value: unknown): value is State =>
  Boolean(value && typeof value === "object" && "counts" in value && Array.isArray((value as State).connectors));

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col rounded-lg border px-3 py-2">
      <span className="text-lg font-semibold tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

/** The workspace at a glance. Read-only: people, tokens and the connector have their own views and tools. */
export function WorkspaceView() {
  const view = useView("workspace");
  const [state] = useWorkspaceState(view, isState);
  const waiting = pending(view, state);
  if (waiting || !state) return waiting;

  const { members, invites, components, tokens } = state.counts;
  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted">
          {state.iconUrl ? (
            <img src={state.iconUrl} alt="" className="size-full object-contain" />
          ) : (
            <ImageIcon className="size-4 text-muted-foreground" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <CardTitle className="truncate">{state.workspace.name}</CardTitle>
          {state.title !== state.workspace.name && <CardDescription className="truncate">Hosts list it as {state.title}</CardDescription>}
        </div>
        <Badge variant={state.public ? "default" : "secondary"}>{state.public ? "public" : "private"}</Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label={members === 1 ? "person" : "people"} value={members} />
          <Stat label={invites === 1 ? "invite" : "invites"} value={invites} />
          <Stat label={components === 1 ? "component" : "components"} value={components} />
          {tokens !== undefined && <Stat label={tokens === 1 ? "token" : "tokens"} value={tokens} />}
        </div>
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">End-user MCP</h3>
          <p className="text-sm text-muted-foreground">
            {state.public
              ? "Anyone with an address can add it as a connector. Your own server uses it with a server token."
              : "Private: only your own server can use it, with a server token (@app-mcp/sdk)."}
          </p>
          {state.connectors.map((c) => (
            <div key={c.environment} className="flex items-center gap-2">
              <Badge variant="outline" className="w-20 justify-center">
                {c.environment}
              </Badge>
              <div className="min-w-0 flex-1">
                <Copyable value={c.url} label={`${c.environment} address`} />
              </div>
            </div>
          ))}
        </section>
      </CardContent>
    </Card>
  );
}
