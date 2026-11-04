import { ImageIcon, Loader2Icon, SaveIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useView } from "@/runtime/useView";
import { pending, Status, useActions, useWorkspaceState } from "./shared";

interface Fields {
  title?: string | null;
  description?: string | null;
  websiteUrl?: string | null;
}

interface State {
  workspace: { id: string; name: string };
  branding: { title?: string; description?: string; websiteUrl?: string; iconUrl: string | null };
  /** From edit_connector with fields: the model's proposal, for the admin to review and save. */
  draft?: Fields;
}

/** Icon change pending save: base64 bytes and a preview, or null to remove it. */
type IconChange = { data: string; preview: string } | null;

const ICON_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];
const MAX_ICON_BYTES = 100_000;
const FIELDS = ["title", "description", "websiteUrl"] as const;

const isState = (value: unknown): value is State =>
  Boolean(value && typeof value === "object" && "branding" in value && "workspace" in value);

/** The saved fields with the model's draft over them; a null in the draft clears a field. */
function formFields({ branding, draft }: State): Record<(typeof FIELDS)[number], string> {
  const pick = (key: (typeof FIELDS)[number]) => (draft && draft[key] !== undefined ? (draft[key] ?? "") : (branding[key] ?? ""));
  return { title: pick("title"), description: pick("description"), websiteUrl: pick("websiteUrl") };
}

/** How hosts list the end-user MCP: icon, title, description and website. */
export function ConnectorView() {
  const view = useView("connector");
  const [state, setState] = useWorkspaceState(view, isState);
  const { busy, message, setMessage, run } = useActions(view.app);
  const [fields, setFields] = useState({ title: "", description: "", websiteUrl: "" });
  const [icon, setIcon] = useState<IconChange | undefined>();
  useEffect(() => {
    if (state) setFields(formFields(state));
  }, [state]);
  const waiting = pending(view, state);
  if (waiting || !state) return waiting;

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

  async function save() {
    // Empty fields clear; the icon is sent only when it changed.
    const values = Object.fromEntries(FIELDS.map((key) => [key, fields[key].trim() || null]));
    const saved = await run("save", "connector_set", values, "The user saved the connector");
    if (!saved || saved.isError) return;
    let latest = saved;
    if (icon !== undefined) {
      const iconSaved = await run("save", "connector_icon_set", { icon: icon?.data ?? null }, "The user changed the connector icon");
      if (!iconSaved || iconSaved.isError) return;
      latest = iconSaved;
      setIcon(undefined);
    }
    if (isState(latest.data)) setState(latest.data);
  }

  const field = (key: (typeof FIELDS)[number]) => ({
    value: fields[key],
    onInput: (event: { currentTarget: HTMLInputElement }) => setFields({ ...fields, [key]: event.currentTarget.value }),
  });
  const iconShown = icon === undefined ? state.branding.iconUrl : (icon?.preview ?? null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connector</CardTitle>
        <CardDescription>
          How hosts like Claude and ChatGPT list your end-user MCP.{state.draft && " Suggested changes are filled in: review and save."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            save();
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
          <Input aria-label="Title" maxLength={80} placeholder={`Title (default: ${state.workspace.name})`} {...field("title")} />
          <Input aria-label="Description" maxLength={500} placeholder="What the connector does, in a sentence" {...field("description")} />
          <Input aria-label="Website" type="url" placeholder="https://www.example.com" {...field("websiteUrl")} />
          <Button type="submit" size="sm" className="self-start" disabled={busy !== null}>
            {busy === "save" ? <Loader2Icon className="animate-spin" /> : <SaveIcon />}
            Save
          </Button>
          <Status message={message} />
        </form>
      </CardContent>
    </Card>
  );
}
