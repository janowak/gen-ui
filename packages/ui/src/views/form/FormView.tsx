import { Field, FORM_META_KEY, FormSpec, SubmitResult } from "@genui/format";
import { useViewState } from "@genui/kit/react";
import type { App } from "@modelcontextprotocol/ext-apps";
import { CheckCircle2Icon, Loader2Icon } from "lucide-react";
import { useMemo, useState, type SubmitEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldGroup } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import { callTool } from "@/runtime/tools";
import { toolsReady, useView } from "@/runtime/useView";
import { FieldControl } from "./FieldControl";
import { begin, fail, finish, restoreValues, submitStatus, type SavedForm } from "./saved";
import { summarize, toSubmitValues, validate, type FieldState, type FormState } from "./values";

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
  const { app, connectError, input, streaming, result, viewId, cancelled } = useView("form");
  // use_recipe: the server builds the form and returns it in the result; render_form: the input is the form.
  const recipeForm = result?.meta[FORM_META_KEY];
  const parsed = useMemo(
    () => (recipeForm ? FormSpec.safeParse(recipeForm) : input && !streaming && Array.isArray(input.fields) ? FormSpec.safeParse(input) : undefined),
    [recipeForm, input, streaming],
  );
  const spec = parsed?.success ? parsed.data : undefined;
  const canCall = toolsReady(result);

  // Kept per render, so a re-rendered message comes back as the user left it.
  const [saved, setSaved, storage] = useViewState<SavedForm>({}, "form");
  // Drafts of forms with persistDraft: false stay in this view only.
  const [unsaved, setUnsaved] = useState<FormState>();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  if (connectError) return <Message tone="error">Could not connect to the host: {connectError.message}</Message>;
  if (cancelled) return <Message>Form cancelled.</Message>;
  if (result?.isError) return <Message tone="error">{result.text || "This form could not be shown."}</Message>;
  if (parsed && !parsed.success) return <Message tone="error">Invalid form definition.</Message>;

  // Until saved state is loaded, so a submitted form doesn't flash its fields first.
  if (!spec || !storage.restored) {
    const partial = spec ?? partialSpec(input);
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

  const status = submitStatus(saved);
  if (status === "done") {
    return (
      <Card>
        <CardContent className="flex items-center gap-3">
          <CheckCircle2Icon className="size-5 text-primary" />
          <div className="flex flex-col">
            {spec.title && <span className="text-sm font-medium">{spec.title}</span>}
            <span className="text-sm text-muted-foreground">{saved.submit?.message ?? "Submitted."}</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  const form = spec;
  const persist = form.persistDraft !== false;
  const values = restoreValues(form.fields, persist ? saved.values : unsaved);
  const submitTool = form.submit?.toolName;
  const ready = Boolean(app && result && (!submitTool || canCall));
  const busy = status === "pending";
  const interrupted = status === "interrupted";
  // After an interrupted submit the answers may already have gone through: they can be sent again, not changed.
  const locked = busy || (interrupted && persist);

  function change(name: string, value: FieldState) {
    if (persist) setSaved((prev) => ({ ...prev, values: { ...restoreValues(form.fields, prev.values), [name]: value } }));
    else setUnsaved((prev) => ({ ...restoreValues(form.fields, prev), [name]: value }));
    if (errors[name]) setErrors(({ [name]: _, ...rest }) => rest);
  }

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!app || !ready || busy) return;
    const clientErrors = validate(form.fields, values);
    setErrors(clientErrors);
    setFormError(null);
    if (Object.keys(clientErrors).length) return;

    // Saved before anything is sent: a view closed mid-submit comes back as interrupted, not as an open form.
    setSaved(begin);
    await storage.flush();

    if (!form.submit) {
      await deliver(app, form, summarize(form, values));
      setSaved(finish("Sent."));
      await storage.flush();
      return;
    }

    // One id per rendered form, so the submit tool can ignore a repeated submit.
    const key = form.submit.idempotencyParam && viewId ? { [form.submit.idempotencyParam]: viewId } : {};
    const outcome = await callTool(app, form.submit.toolName, { ...(form.submit.params ?? {}), ...toSubmitValues(form.fields, values), ...key });
    const response = SubmitResult.safeParse(outcome.data);

    if (response.success && !response.data.ok) {
      setErrors(response.data.fieldErrors ?? {});
      setFormError(response.data.formError ?? (response.data.fieldErrors ? null : "Submission was rejected."));
      setSaved(fail);
      return;
    }
    if (!response.success && outcome.isError) {
      setFormError(outcome.text || "Submission failed.");
      setSaved(fail);
      return;
    }

    const message = (response.success && response.data.ok ? response.data.message : undefined) ?? (outcome.text || "Submitted.");
    setSaved(finish(message));
    await storage.flush();
    await deliver(app, form, summarize(form, values, message));
  }

  return (
    <Card className="gap-4">
      {(form.title || form.description) && (
        <CardHeader>
          {form.title && <CardTitle>{form.title}</CardTitle>}
          {form.description && <CardDescription>{form.description}</CardDescription>}
        </CardHeader>
      )}
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <CardContent>
          <FieldGroup>
          {form.fields.map((field) => (
            <FieldControl
              key={field.name}
              field={field}
              value={values[field.name]}
              error={errors[field.name]}
              disabled={locked}
              app={app}
              canCall={canCall}
              onChange={(value) => change(field.name, value)}
            />
          ))}
          {interrupted && (
            <p role="status" className="text-sm text-muted-foreground">
              We couldn't confirm this was sent. {persist ? "Send it again to make sure." : "Fill it in and send it again."}
            </p>
          )}
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
            {interrupted ? "Send again" : (form.submit?.label ?? "Submit")}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

function Message({ children, tone }: { children: React.ReactNode; tone?: "error" }) {
  return <p className={tone === "error" ? "p-3 text-sm text-destructive" : "p-3 text-sm text-muted-foreground"}>{children}</p>;
}
