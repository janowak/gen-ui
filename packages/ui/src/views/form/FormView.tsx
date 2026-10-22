import { Field, FORM_META_KEY, FormSpec, SubmitResult } from "@genui/format";
import type { App } from "@modelcontextprotocol/ext-apps";
import { CheckCircle2Icon, Loader2Icon } from "lucide-react";
import { useEffect, useMemo, useState, type SubmitEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldGroup } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import { callTool } from "@/runtime/tools";
import { toolsReady, useView } from "@/runtime/useView";
import { FieldControl } from "./FieldControl";
import { initialState, summarize, toSubmitValues, validate, type FormState } from "./values";

type Status = { kind: "editing" } | { kind: "submitting" } | { kind: "done"; message: string };

/**
 * Puts the submitted values into the model's context, then posts a short message so the model
 * replies. Hosts without model context get the values in the message itself.
 */
async function deliver(app: App, spec: FormSpec, summary: string): Promise<void> {
  const inContext = await app.updateModelContext({ content: [{ type: "text", text: summary }] }).then(
    () => true,
    () => false,
  );
  const text = inContext ? `Submitted ${spec.title ? `"${spec.title}"` : "the form"}.` : summary;
  await app.sendMessage({ role: "user", content: [{ type: "text", text }] }).catch(() => {});
}

/** While the model streams the spec, render the fields that are already complete. */
function partialSpec(input: Record<string, unknown> | undefined): { title?: string; fields: Field[] } {
  const fields = Array.isArray(input?.fields) ? input.fields.flatMap((f) => (Field.safeParse(f).success ? [Field.parse(f)] : [])) : [];
  return { title: typeof input?.title === "string" ? input.title : undefined, fields };
}

export function FormView() {
  const { app, connectError, input, streaming, result, cancelled } = useView("form");
  // use_recipe: the server builds the form and returns it in the result; render_form: the input is the form.
  const recipeForm = result?.meta[FORM_META_KEY];
  const parsed = useMemo(
    () => (recipeForm ? FormSpec.safeParse(recipeForm) : input && !streaming && Array.isArray(input.fields) ? FormSpec.safeParse(input) : undefined),
    [recipeForm, input, streaming],
  );
  const spec = parsed?.success ? parsed.data : undefined;
  const canCall = toolsReady(result);

  const [state, setState] = useState<FormState>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "editing" });

  useEffect(() => {
    if (spec) setState(initialState(spec.fields));
  }, [spec]);

  if (connectError) return <Message tone="error">Could not connect to the host: {connectError.message}</Message>;
  if (cancelled) return <Message>Form cancelled.</Message>;
  if (result?.isError) return <Message tone="error">{result.text || "This form could not be shown."}</Message>;
  if (parsed && !parsed.success) return <Message tone="error">Invalid form definition.</Message>;

  if (!spec) {
    const partial = partialSpec(input);
    return (
      <Card className="gap-4">
        <CardHeader>{partial.title ? <CardTitle>{partial.title}</CardTitle> : <Skeleton className="h-5 w-40" />}</CardHeader>
        <CardContent className="flex flex-col gap-4">
          {partial.fields.map((f) => (
            <div key={f.name} className="flex flex-col gap-2">
              <span className="text-sm font-medium">{f.label}</span>
              <Skeleton className="h-9 w-full" />
            </div>
          ))}
          <Skeleton className="h-9 w-full" />
        </CardContent>
      </Card>
    );
  }

  const submitTool = spec.submit?.toolName;
  const ready = Boolean(app && result && (!submitTool || canCall));
  const busy = status.kind === "submitting";

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!app || !spec || !ready || busy) return;
    const clientErrors = validate(spec.fields, state);
    setErrors(clientErrors);
    setFormError(null);
    if (Object.keys(clientErrors).length) return;

    setStatus({ kind: "submitting" });
    const values = toSubmitValues(spec.fields, state);

    if (!spec.submit) {
      await deliver(app, spec, summarize(spec, state));
      setStatus({ kind: "done", message: "Sent." });
      return;
    }

    const outcome = await callTool(app, spec.submit.toolName, { ...(spec.submit.params ?? {}), ...values });
    const response = SubmitResult.safeParse(outcome.data);

    if (response.success && !response.data.ok) {
      setErrors(response.data.fieldErrors ?? {});
      setFormError(response.data.formError ?? (response.data.fieldErrors ? null : "Submission was rejected."));
      setStatus({ kind: "editing" });
      return;
    }
    if (!response.success && outcome.isError) {
      setFormError(outcome.text || "Submission failed.");
      setStatus({ kind: "editing" });
      return;
    }

    const message = (response.success && response.data.ok ? response.data.message : undefined) ?? (outcome.text || "Submitted.");
    setStatus({ kind: "done", message });
    await deliver(app, spec, summarize(spec, state, message));
  }

  if (status.kind === "done") {
    return (
      <Card>
        <CardContent className="flex items-center gap-3">
          <CheckCircle2Icon className="size-5 text-primary" />
          <div className="flex flex-col">
            {spec.title && <span className="text-sm font-medium">{spec.title}</span>}
            <span className="text-sm text-muted-foreground">{status.message}</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="gap-4">
      {(spec.title || spec.description) && (
        <CardHeader>
          {spec.title && <CardTitle>{spec.title}</CardTitle>}
          {spec.description && <CardDescription>{spec.description}</CardDescription>}
        </CardHeader>
      )}
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <CardContent>
          <FieldGroup>
          {spec.fields.map((field) => (
            <FieldControl
              key={field.name}
              field={field}
              value={state[field.name]}
              error={errors[field.name]}
              disabled={busy}
              app={app}
              canCall={canCall}
              onChange={(value) => {
                setState((prev) => ({ ...prev, [field.name]: value }));
                if (errors[field.name]) setErrors(({ [field.name]: _, ...rest }) => rest);
              }}
            />
          ))}
          {formError && (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          )}
          </FieldGroup>
        </CardContent>
        <CardFooter>
          <Button type="submit" disabled={!ready || busy} className="w-full sm:w-auto">
            {busy && <Loader2Icon className="animate-spin" />}
            {spec.submit?.label ?? "Submit"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

function Message({ children, tone }: { children: React.ReactNode; tone?: "error" }) {
  return <p className={tone === "error" ? "p-3 text-sm text-destructive" : "p-3 text-sm text-muted-foreground"}>{children}</p>;
}
