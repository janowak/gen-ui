import type { App } from "@modelcontextprotocol/ext-apps";
import { CopyIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { callTool, type ToolCallOutcome } from "@/runtime/tools";
import type { ViewState } from "@/runtime/useView";

// What the workspace views (summary, members, tokens, connector) share.

export type Role = "member" | "admin";
export type Scope = "server" | "publish" | "admin";

/** The state a view shows, from the tool that opened it and from each action after. */
export function useWorkspaceState<S>(view: ViewState, isState: (value: unknown) => value is S) {
  const [state, setState] = useState<S>();
  useEffect(() => {
    const structured = view.result?.structured;
    if (isState(structured)) setState(structured);
  }, [view.result, isState]);
  return [state, setState] as const;
}

/** The connection error, the tool's error or a placeholder, until the view has its state. */
export function pending(view: ViewState, state: unknown): ReactNode | undefined {
  if (view.connectError) return <p className="p-3 text-sm text-destructive">Could not connect to the host: {view.connectError.message}</p>;
  if (view.result?.isError) return <p className="p-3 text-sm text-destructive">{view.result.text}</p>;
  if (!state) return <Skeleton className="m-px h-40 w-full" />;
}

export interface Message {
  text: string;
  error?: boolean;
}

/**
 * Runs a tool on a click: one at a time, with a status message. After a success the tool's text goes to the
 * model's context; no tool's text ever holds a secret, so that's safe.
 */
export function useActions(app: App | null) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);

  async function run(key: string, tool: string, args: Record<string, unknown>, note: string): Promise<ToolCallOutcome | undefined> {
    if (!app) return;
    setBusy(key);
    setMessage(null);
    const outcome = await callTool(app, tool, args);
    setBusy(null);
    setMessage({ text: outcome.text, error: outcome.isError });
    if (!outcome.isError) await app.updateModelContext({ content: [{ type: "text", text: `${note}: ${outcome.text}` }] }).catch(() => {});
    return outcome;
  }

  return { busy, message, setMessage, run };
}

export function Status({ message }: { message: Message | null }) {
  if (!message) return null;
  return (
    <p role="status" className={message.error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
      {message.text}
    </p>
  );
}

export function Choice<T extends string>({
  value,
  options,
  onChange,
  disabled,
  label,
}: {
  value: T;
  options: T[];
  onChange: (v: T) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <div className="flex gap-1" role="group" aria-label={label}>
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

/** A value with a Copy button. `onCopied` runs after a successful copy. */
export function Copyable({ value, label, onCopied }: { value: string; label?: string; onCopied?: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs select-all" title={value} aria-label={label}>
        {value}
      </code>
      <Button
        size="sm"
        variant="outline"
        onClick={() =>
          navigator.clipboard?.writeText(value).then(
            () => {
              setCopied(true);
              onCopied?.();
            },
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
