import type { Field as FieldSpec, Option } from "@genui/format";
import type { App } from "@modelcontextprotocol/ext-apps";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { DatePicker } from "./DatePicker";
import { OptionCombobox } from "./OptionCombobox";
import { ResourceSelect } from "./ResourceSelect";
import type { FieldState } from "./values";

interface Props {
  field: FieldSpec;
  value: FieldState;
  error?: string;
  disabled: boolean;
  app: App | null;
  /** Whether tool-backed selects may load their options. */
  canCall: boolean;
  onChange: (value: FieldState) => void;
}

/** One form field, laid out with shadcn Field primitives as in the shadcn field examples. */
export function FieldControl({ field, value, error, disabled, app, canCall, onChange }: Props) {
  const id = `field-${field.name}`;
  const invalid = Boolean(error);
  const label = (
    <>
      {field.label}
      {field.required && <span className="text-destructive">*</span>}
    </>
  );
  const description = field.description && <FieldDescription>{field.description}</FieldDescription>;
  const errors = error ? <FieldError errors={[{ message: error }]} /> : null;

  if (field.type === "checkbox" || field.type === "switch") {
    const Control = field.type === "checkbox" ? Checkbox : Switch;
    return (
      <Field orientation="horizontal" data-invalid={invalid || undefined}>
        <Control
          id={id}
          checked={value === true}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          onCheckedChange={(checked) => onChange(checked)}
        />
        <FieldContent>
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          {description}
          {errors}
        </FieldContent>
      </Field>
    );
  }

  if (field.type === "radio") {
    return (
      <FieldSet data-invalid={invalid || undefined}>
        <FieldLegend variant="label">{label}</FieldLegend>
        {description}
        <RadioGroup value={(value as string) ?? null} disabled={disabled} onValueChange={(next) => onChange(next as string)}>
          {field.options.map((option) => (
            <Field key={option.id} orientation="horizontal">
              <RadioGroupItem value={option.id} id={`${id}-${option.id}`} aria-invalid={invalid || undefined} />
              <FieldLabel htmlFor={`${id}-${option.id}`}>{option.label}</FieldLabel>
            </Field>
          ))}
        </RadioGroup>
        {errors}
      </FieldSet>
    );
  }

  return (
    <Field data-invalid={invalid || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Control id={id} field={field} value={value} invalid={invalid} disabled={disabled} app={app} canCall={canCall} onChange={onChange} />
      {description}
      {errors}
    </Field>
  );
}

function Control({ id, field, value, invalid, disabled, app, canCall, onChange }: Omit<Props, "error"> & { id: string; invalid: boolean }) {
  const aria = invalid || undefined;
  switch (field.type) {
    case "text":
    case "email":
      return (
        <Input
          id={id}
          type={field.type}
          value={(value as string) ?? ""}
          placeholder={field.placeholder}
          disabled={disabled}
          aria-invalid={aria}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "textarea":
      return (
        <Textarea
          id={id}
          value={(value as string) ?? ""}
          placeholder={field.placeholder}
          disabled={disabled}
          aria-invalid={aria}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "number":
      return (
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          value={value === undefined ? "" : String(value)}
          min={field.min}
          max={field.max}
          step={field.step}
          placeholder={field.placeholder}
          disabled={disabled}
          aria-invalid={aria}
          onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
        />
      );
    case "date":
      return <DatePicker id={id} value={value as string | undefined} onChange={onChange} invalid={invalid} disabled={disabled} />;
    case "select": {
      // As in the shadcn select examples: a null item carries the placeholder label.
      const items = [
        { label: field.placeholder ?? "Select…", value: null as string | null },
        ...field.options.map((o) => ({ label: o.label, value: o.id as string | null })),
      ];
      return (
        <Select items={items} value={(value as string) ?? null} disabled={disabled} onValueChange={(next) => onChange(next ?? undefined)}>
          <SelectTrigger id={id} className="w-full" aria-invalid={aria}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {items.map((item) => (
                <SelectItem key={item.value ?? ""} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      );
    }
    case "multiselect": {
      const ids = (value as string[]) ?? [];
      return (
        <OptionCombobox
          id={id}
          multiple
          items={field.options}
          value={field.options.filter((o) => ids.includes(o.id))}
          onChange={(next) => onChange(next.map((o) => o.id))}
          placeholder={field.placeholder}
          invalid={invalid}
          disabled={disabled}
        />
      );
    }
    case "resource_select":
      return (
        <ResourceSelect
          id={id}
          app={app}
          source={field.source}
          ready={canCall}
          value={value as Option | undefined}
          onChange={onChange}
          placeholder={field.placeholder}
          invalid={invalid}
          disabled={disabled}
        />
      );
    case "resource_multiselect":
      return (
        <ResourceSelect
          id={id}
          app={app}
          source={field.source}
          ready={canCall}
          multiple
          value={(value as Option[]) ?? []}
          onChange={onChange}
          placeholder={field.placeholder}
          invalid={invalid}
          disabled={disabled}
        />
      );
    default:
      return null;
  }
}
