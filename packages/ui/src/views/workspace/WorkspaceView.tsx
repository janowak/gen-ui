import { CopyIcon, ImageIcon, KeyRoundIcon, Loader2Icon, SaveIcon, Trash2Icon, UserPlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { callTool } from "@/runtime/tools";
import { useView } from "@/runtime/useView";

type Role = "member" | "admin";
type Scope = "server" | "publish" | "admin";

interface Branding {
  title?: string;
  description?: string;
  websiteUrl?: string;
}

/** Icon change pending save: base64 bytes and a preview, or null to remove it. */
type IconChange = { data: string; preview: string } | null;

const ICON_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];
const MAX_ICON_BYTES = 100_000;

interface State {
  role: Role;
  workspace: { id: string; name: string };
  /** How hosts show the end-user MCP. */
  branding: Branding & { iconUrl: string | null };
  members: { userId: string; name: string | null; email: string | null; role: Role }[];
  invites: { email: string; role: Role }[];
  public: boolean;
  /** The end-user MCP address of each environment. */
  connectors: { environment: string; url: string }[];
  /** Admins only. */
  tokens?: { id: string; name: string; scope: Scope; createdAt: string }[];
  /** From manage_workspace({ invite }): prefills the invite form. */
  draftInvite?: { email: string; role: Role };
  /** From token_create only: the one time the token is shown. Never sent to the model. */
  created?: { name: string; scope: Scope; token: string };
}

const isState = (value: unknown): value is State =>
  Boolean(value && typeof value === "object" && Array.isArray((value as State).members) && Array.isArray((value as State).connectors));

function Choice<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: T[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex gap-1" role="group">
      {options.map((option) => (
        <Button
          key={option}
          type="button"
          size="sm"
          variant={option === value ? "default" : "outline"}
          aria-pressed={option === value}
          disabled={disabled}
          onClick={() => onChange(option)}
        >
          {option}
        </Button>
      ))}
    </div>
  );
}

function Copyable({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs select-all" title={value}>
        {value}
      </code>
      <Button
        size="sm"
        variant="outline"
        onClick={() =>
          navigator.clipboard?.writeText(value).then(
            () => setCopied(true),
            () => setCopied(false),
          )
        }
      >
        <CopyIcon />
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

/** Members and invites, server tokens and the public switch. Changes run only on a click (app-only tools). */
export function WorkspaceView() {
  const { app, connectError, result } = useView("workspace");
  const [state, setState] = useState<State>();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [invite, setInvite] = useState<{ email: string; role: Role }>({ email: "", role: "member" });
  const [token, setToken] = useState<{ name: string; scope: Scope }>({ name: "", scope: "server" });
  const [branding, setBranding] = useState<Branding>({});
  const [icon, setIcon] = useState<IconChange | undefined>();

  function show(next: State) {
    setState(next);
    const { iconUrl: _, ...rest } = next.branding;
    setBranding(rest);
    setIcon(undefined);
  }

  useEffect(() => {
    if (!isState(result?.structured)) return;
    show(result.structured);
    if (result.structured.draftInvite) setInvite(result.structured.draftInvite);
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
    if (isState(outcome.data)) {
      // Keep unsaved branding edits when another action refreshes the state.
      if (tool === "branding_save" && !outcome.isError) show(outcome.data);
      else setState(outcome.data);
    }
    setMessage({ text: outcome.text, error: outcome.isError });
    // The tool text never holds a token, so it's safe to tell the model.
    if (!outcome.isError) await app.updateModelContext({ content: [{ type: "text", text: `${note}: ${outcome.text}` }] }).catch(() => {});
    return outcome;
  }

  function pickIcon(file: File | undefined) {
    if (!file) return;
    if (!ICON_TYPES.includes(file.type)) return setMessage({ text: "Pick a PNG, JPEG, WebP or SVG image.", error: true });
    if (file.size > MAX_ICON_BYTES) return setMessage({ text: `The icon is over ${MAX_ICON_BYTES / 1000} KB.`, error: true });
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      setIcon({ data: url.slice(url.indexOf(",") + 1), preview: url });
      setMessage(null);
    };
    reader.readAsDataURL(file);
  }

  const brandingField = (key: keyof Branding) => (event: { currentTarget: HTMLInputElement }) =>
    setBranding({ ...branding, [key]: event.currentTarget.value || undefined });
  const iconShown = icon === undefined ? state.branding.iconUrl : (icon?.preview ?? null);

  const status = message && (
    <p role="status" className={message.error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
      {message.text}
    </p>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{state.workspace.name}</CardTitle>
        <CardDescription>Who manages this workspace, and how your servers and users reach its MCP.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">People</h3>
          <Table>
            <TableBody>
              {state.members.map((m) => (
                <TableRow key={m.userId}>
                  <TableCell className="font-medium">{m.name ?? m.email}</TableCell>
                  <TableCell className="text-muted-foreground">{m.name ? m.email : ""}</TableCell>
                  <TableCell className="text-right">
                    <Badge variant={m.role === "admin" ? "default" : "secondary"}>{m.role}</Badge>
                  </TableCell>
                </TableRow>
              ))}
              {state.invites.map((i) => (
                <TableRow key={i.email}>
                  <TableCell className="font-medium">{i.email}</TableCell>
                  <TableCell className="text-muted-foreground">invited as {i.role}</TableCell>
                  <TableCell className="text-right">
                    {isAdmin && (
                      <Button
                        size="sm"
                        variant={confirm === `invite:${i.email}` ? "destructive" : "outline"}
                        disabled={busy !== null}
                        onClick={() =>
                          confirm === `invite:${i.email}`
                            ? run(`invite:${i.email}`, "invite_cancel", { email: i.email }, "The user cancelled an invite")
                            : setConfirm(`invite:${i.email}`)
                        }
                      >
                        {busy === `invite:${i.email}` ? <Loader2Icon className="animate-spin" /> : <Trash2Icon />}
                        {confirm === `invite:${i.email}` ? "Confirm" : "Cancel invite"}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {isAdmin && (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={async (event) => {
                event.preventDefault();
                const outcome = await run("invite", "member_invite", invite, "The user invited someone");
                if (outcome && !outcome.isError) setInvite({ email: "", role: "member" });
              }}
            >
              <Input
                type="email"
                required
                placeholder="name@company.com"
                aria-label="Email to invite"
                className="w-56 flex-1"
                value={invite.email}
                onInput={(event) => setInvite({ ...invite, email: (event.target as HTMLInputElement).value })}
              />
              <Choice
                value={invite.role}
                options={["member", "admin"]}
                onChange={(role) => setInvite({ ...invite, role })}
                disabled={busy !== null}
              />
              <Button type="submit" size="sm" disabled={busy !== null || !invite.email}>
                {busy === "invite" ? <Loader2Icon className="animate-spin" /> : <UserPlusIcon />}
                Invite
              </Button>
            </form>
          )}
          {isAdmin && (
            <p className="text-xs text-muted-foreground">They join when they next connect genui and sign in with that verified email.</p>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Connector</h3>
          <p className="text-sm text-muted-foreground">
            How hosts like Claude and ChatGPT show your end-user MCP. Instructions and workflows are set per environment
            (manage_instructions, manage_workflows).
          </p>
          {isAdmin ? (
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                run(
                  "branding",
                  "branding_save",
                  { branding, ...(icon !== undefined ? { icon: icon?.data ?? null } : {}) },
                  "The user saved the connector branding",
                );
              }}
            >
              <div className="flex items-center gap-3">
                <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted">
                  {iconShown ? (
                    <img src={iconShown} alt="Connector icon" className="size-full object-contain" />
                  ) : (
                    <ImageIcon className="size-5 text-muted-foreground" />
                  )}
                </div>
                <label className="cursor-pointer">
                  <input
                    type="file"
                    accept={ICON_TYPES.join(",")}
                    className="sr-only"
                    onChange={(event) => pickIcon((event.target as HTMLInputElement).files?.[0])}
                  />
                  <span className="inline-flex h-7 items-center rounded-md border px-2.5 text-sm">
                    {iconShown ? "Change icon" : "Upload icon"}
                  </span>
                </label>
                {iconShown && (
                  <Button type="button" size="sm" variant="outline" onClick={() => setIcon(null)}>
                    Remove
                  </Button>
                )}
                <span className="text-xs text-muted-foreground">Square PNG, SVG, WebP or JPEG, up to 100 KB.</span>
              </div>
              <Input
                aria-label="Title"
                maxLength={80}
                placeholder={`Title (default: ${state.workspace.name})`}
                value={branding.title ?? ""}
                onInput={brandingField("title")}
              />
              <Input
                aria-label="Description"
                maxLength={500}
                placeholder="What the connector does, in a sentence"
                value={branding.description ?? ""}
                onInput={brandingField("description")}
              />
              <Input
                aria-label="Website"
                type="url"
                placeholder="https://www.example.com"
                value={branding.websiteUrl ?? ""}
                onInput={brandingField("websiteUrl")}
              />
              <Button type="submit" size="sm" className="self-start" disabled={busy !== null}>
                {busy === "branding" ? <Loader2Icon className="animate-spin" /> : <SaveIcon />}
                Save connector
              </Button>
            </form>
          ) : (
            <div className="flex items-center gap-3">
              {state.branding.iconUrl && <img src={state.branding.iconUrl} alt="" className="size-10 rounded-lg border object-contain" />}
              <div className="min-w-0">
                <p className="text-sm font-medium">{state.branding.title ?? state.workspace.name}</p>
                {state.branding.description && <p className="text-sm text-muted-foreground">{state.branding.description}</p>}
              </div>
            </div>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium">End-user MCP</h3>
            {isAdmin ? (
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={state.public}
                  disabled={busy !== null}
                  onCheckedChange={(enabled: boolean) => run("public", "public_set", { enabled }, "The user changed the public MCP")}
                />
                Public
              </label>
            ) : (
              <Badge variant="outline">{state.public ? "public" : "private"}</Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {state.public
              ? "Anyone with an address below can add it as a connector. Your own server can use it too, with a server token."
              : "Private: only your own server can use it, with a server token (@app-mcp/sdk)."}
          </p>
          {state.connectors.map((c) => (
            <div key={c.environment} className="flex items-center gap-2">
              <Badge variant="outline" className="w-20 justify-center">
                {c.environment}
              </Badge>
              <div className="min-w-0 flex-1">
                <Copyable value={c.url} />
              </div>
            </div>
          ))}
        </section>

        {isAdmin && state.tokens && (
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Tokens</h3>
            <p className="text-sm text-muted-foreground">
              <b>server</b>: your MCP server forwards genui's tools with @app-mcp/sdk. <b>publish</b>: you or CI publish components with{" "}
              <code>genui publish</code>. <b>admin</b>: every genui CLI command.
            </p>
            {state.created && (
              <div className="flex flex-col gap-2 rounded-lg border border-primary/40 p-3">
                <p className="text-sm">
                  Token <b>{state.created.name}</b> ({state.created.scope}). Copy it now: it isn't shown again.
                </p>
                <Copyable value={state.created.token} />
                {state.created.scope === "server" && (
                  <p className="text-xs text-muted-foreground">
                    In your server's environment: <code>GENUI_MCP_TOKEN</code> = this token, <code>GENUI_MCP_URL</code> = an end-user MCP
                    address above.
                  </p>
                )}
                {state.created.scope !== "server" && (
                  <p className="text-xs text-muted-foreground">
                    Use it as <code>GENUI_TOKEN</code>: <code>GENUI_TOKEN=… npx genui publish</code> in a component made with{" "}
                    <code>npx @app-mcp/cli init</code>.
                  </p>
                )}
              </div>
            )}
            {state.tokens.length > 0 && (
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
                    <TableRow key={t.id}>
                      <TableCell className="font-medium">{t.name}</TableCell>
                      <TableCell>
                        <Badge variant="secondary">{t.scope}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{t.createdAt.slice(0, 10)}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant={confirm === t.id ? "destructive" : "outline"}
                          disabled={busy !== null}
                          onClick={() =>
                            confirm === t.id ? run(t.id, "token_revoke", { id: t.id }, "The user revoked a token") : setConfirm(t.id)
                          }
                        >
                          {busy === t.id ? <Loader2Icon className="animate-spin" /> : <Trash2Icon />}
                          {confirm === t.id ? "Confirm revoke" : "Revoke"}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={async (event) => {
                event.preventDefault();
                const outcome = await run("token", "token_create", token, "The user created a token");
                if (outcome && !outcome.isError) setToken({ name: "", scope: "server" });
              }}
            >
              <Input
                required
                maxLength={80}
                placeholder="e.g. production server"
                aria-label="Token name"
                className="w-56 flex-1"
                value={token.name}
                onInput={(event) => setToken({ ...token, name: (event.target as HTMLInputElement).value })}
              />
              <Choice
                value={token.scope}
                options={["server", "publish", "admin"]}
                onChange={(scope) => setToken({ ...token, scope })}
                disabled={busy !== null}
              />
              <Button type="submit" size="sm" disabled={busy !== null || !token.name}>
                {busy === "token" ? <Loader2Icon className="animate-spin" /> : <KeyRoundIcon />}
                Create token
              </Button>
            </form>
          </section>
        )}
        {status}
      </CardContent>
    </Card>
  );
}
