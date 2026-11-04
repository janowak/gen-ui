import { Loader2Icon, Trash2Icon, UserPlusIcon } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { useView } from "@/runtime/useView";
import { Choice, pending, Status, useActions, useWorkspaceState, type Role } from "./shared";

interface State {
  role: Role;
  /** The viewer's user id. */
  me: string;
  members: { userId: string; name: string | null; email: string | null; role: Role }[];
  invites: { email: string; role: Role }[];
}

const isState = (value: unknown): value is State =>
  Boolean(value && typeof value === "object" && Array.isArray((value as State).members) && Array.isArray((value as State).invites));

/** People and pending invites. Admins invite, change roles and remove people here or by asking the model. */
export function MembersView() {
  const view = useView("members");
  const [state, setState] = useWorkspaceState(view, isState);
  const { busy, message, run } = useActions(view.app);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [invite, setInvite] = useState<{ email: string; role: Role }>({ email: "", role: "member" });
  const waiting = pending(view, state);
  if (waiting || !state) return waiting;

  const isAdmin = state.role === "admin";
  async function act(key: string, tool: string, args: Record<string, unknown>, note: string) {
    const outcome = await run(key, tool, args, note);
    setConfirm(null);
    if (outcome && isState(outcome.data)) setState(outcome.data);
    return outcome;
  }
  // Removing and cancelling take a second click.
  const confirmed = (key: string, then: () => void) => (confirm === key ? then() : setConfirm(key));

  return (
    <Card>
      <CardHeader>
        <CardTitle>People</CardTitle>
        <CardDescription>Who manages this workspace: admins change settings, members browse and preview.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Table>
          <TableBody>
            {state.members.map((m) => {
              const email = m.email ?? m.userId;
              return (
                <TableRow key={m.userId}>
                  <TableCell>
                    <div className="font-medium">
                      {m.name ?? email}
                      {m.userId === state.me && <span className="font-normal text-muted-foreground"> (you)</span>}
                    </div>
                    {m.name && m.email && <div className="text-xs text-muted-foreground">{m.email}</div>}
                  </TableCell>
                  <TableCell className="text-right">
                    {isAdmin && m.email ? (
                      <div className="flex justify-end gap-2">
                        <Choice
                          label={`Role of ${email}`}
                          value={m.role}
                          options={["member", "admin"]}
                          disabled={busy !== null}
                          onChange={(role) =>
                            role !== m.role && act(`role:${email}`, "member_set_role", { email, role }, "The user changed a role")
                          }
                        />
                        <Button
                          size="sm"
                          variant={confirm === `remove:${email}` ? "destructive" : "outline"}
                          disabled={busy !== null}
                          aria-label={`Remove ${email}`}
                          onClick={() =>
                            confirmed(`remove:${email}`, () =>
                              act(`remove:${email}`, "member_remove", { email }, "The user removed someone"),
                            )
                          }
                        >
                          {busy === `remove:${email}` ? <Loader2Icon className="animate-spin" /> : <Trash2Icon />}
                          {confirm === `remove:${email}` ? "Confirm" : null}
                        </Button>
                      </div>
                    ) : (
                      <Badge variant={m.role === "admin" ? "default" : "secondary"}>{m.role}</Badge>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {state.invites.map((i) => (
              <TableRow key={i.email}>
                <TableCell>
                  <div className="font-medium">{i.email}</div>
                  <div className="text-xs text-muted-foreground">invited as {i.role}</div>
                </TableCell>
                <TableCell className="text-right">
                  {isAdmin && (
                    <Button
                      size="sm"
                      variant={confirm === `invite:${i.email}` ? "destructive" : "outline"}
                      disabled={busy !== null}
                      onClick={() =>
                        confirmed(`invite:${i.email}`, () =>
                          act(`invite:${i.email}`, "invite_cancel", { email: i.email }, "The user cancelled an invite"),
                        )
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
            className="flex flex-col gap-1"
            onSubmit={async (event) => {
              event.preventDefault();
              const outcome = await act("invite", "member_invite", invite, "The user invited someone");
              if (outcome && !outcome.isError) setInvite({ email: "", role: "member" });
            }}
          >
            <div className="flex flex-wrap items-center gap-2">
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
                label="Invite as"
                value={invite.role}
                options={["member", "admin"]}
                onChange={(role) => setInvite({ ...invite, role })}
                disabled={busy !== null}
              />
              <Button type="submit" size="sm" disabled={busy !== null || !invite.email}>
                {busy === "invite" ? <Loader2Icon className="animate-spin" /> : <UserPlusIcon />}
                Invite
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">They join when they next connect app-mcp and sign in with that verified email.</p>
          </form>
        )}
        <Status message={message} />
      </CardContent>
    </Card>
  );
}
