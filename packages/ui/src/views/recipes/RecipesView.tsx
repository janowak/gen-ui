import { Recipe } from "@genui/format";
import { Loader2Icon, SaveIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { callTool } from "@/runtime/tools";
import { useView } from "@/runtime/useView";

type Role = "member" | "admin";
type State =
  | { mode: "list"; role: Role; recipes: Recipe[] }
  | { mode: "draft"; role: Role; recipe: Recipe; replaces: boolean; saved?: boolean };

function parseState(value: unknown): State | undefined {
  const v = value as { mode?: string; role?: Role; recipes?: unknown[]; recipe?: unknown; replaces?: boolean; saved?: boolean } | undefined;
  if (v?.mode === "list" && Array.isArray(v.recipes)) {
    return { mode: "list", role: v.role ?? "member", recipes: v.recipes.flatMap((r) => (Recipe.safeParse(r).success ? [Recipe.parse(r)] : [])) };
  }
  if (v?.mode === "draft") {
    const recipe = Recipe.safeParse(v.recipe);
    if (recipe.success) return { mode: "draft", role: v.role ?? "member", recipe: recipe.data, replaces: Boolean(v.replaces), saved: v.saved };
  }
  return undefined;
}

function fieldSummary(field: Recipe["form"]["fields"][number]): string {
  if (field.type === "resource_select" || field.type === "resource_multiselect") return `${field.type} from ${field.source.toolName}`;
  if (field.type === "select" || field.type === "radio" || field.type === "multiselect") return `${field.type}, ${field.options.length} options`;
  return field.type;
}

/** Workspace recipes: list (with delete) and draft review (with save). Changes run only on a click (app-only tools). */
export function RecipesView() {
  const { app, connectError, result } = useView("recipes");
  const [state, setState] = useState<State>();
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

  if (state.mode === "draft") {
    const { recipe } = state;
    return (
      <Card>
        <CardHeader>
          <CardTitle>
            Recipe <code>/{recipe.name}</code>
            {recipe.title && <span className="font-normal text-muted-foreground"> · {recipe.title}</span>}
          </CardTitle>
          <CardDescription>{recipe.when}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Field</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Required</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recipe.form.fields.map((field) => (
                <TableRow key={field.name}>
                  <TableCell className="font-medium">{field.label}</TableCell>
                  <TableCell className="text-muted-foreground">{fieldSummary(field)}</TableCell>
                  <TableCell className="text-right">{field.required ? "yes" : ""}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">On submit:</span>
            {recipe.form.submit ? <Badge variant="secondary">{recipe.form.submit.toolName}</Badge> : <span>values go back to the conversation</span>}
          </div>
          {recipe.notes && <p className="text-sm text-muted-foreground">Notes for the AI: {recipe.notes}</p>}
          {state.replaces && !state.saved && <p className="text-sm text-muted-foreground">Saving replaces the existing /{recipe.name} recipe.</p>}
        </CardContent>
        <CardFooter className="flex items-center gap-2">
          {isAdmin ? (
            <Button disabled={busy !== null || state.saved} onClick={() => run("save", "recipe_save", { recipe }, "The user saved a recipe")}>
              {busy === "save" ? <Loader2Icon className="animate-spin" /> : <SaveIcon />}
              {state.saved ? "Saved" : state.replaces ? "Replace recipe" : "Save recipe"}
            </Button>
          ) : (
            <span className="text-sm text-muted-foreground">Only admins can save recipes.</span>
          )}
          {message && <span className={message.error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>{message.text}</span>}
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recipes</CardTitle>
        <CardDescription>Ready-made forms the AI uses for matching requests. Each one is also a slash command.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {state.recipes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No recipes yet. Ask to draft one, e.g. "make a recipe for adding a product".</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Command</TableHead>
                <TableHead>When</TableHead>
                <TableHead>Fields</TableHead>
                {isAdmin && <TableHead className="text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.recipes.map((r) => (
                <TableRow key={r.name}>
                  <TableCell className="font-medium">/{r.name}</TableCell>
                  <TableCell className="max-w-64 truncate text-muted-foreground" title={r.when}>
                    {r.when}
                  </TableCell>
                  <TableCell>{r.form.fields.length}</TableCell>
                  {isAdmin && (
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant={confirm === r.name ? "destructive" : "outline"}
                        disabled={busy !== null}
                        onClick={() => (confirm === r.name ? run(r.name, "recipe_delete", { name: r.name }, "The user deleted a recipe") : setConfirm(r.name))}
                      >
                        {busy === r.name ? <Loader2Icon className="animate-spin" /> : <Trash2Icon />}
                        {confirm === r.name ? "Confirm delete" : "Delete"}
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
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
