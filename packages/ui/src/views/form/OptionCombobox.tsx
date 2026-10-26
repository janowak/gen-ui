import type { Option } from "@genui/format";
import { Loader2Icon, RotateCwIcon } from "lucide-react";
import { Fragment } from "react";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from "@/components/ui/combobox";

/** Options loaded by a tool: drives server-side search and the loading / error states. */
export interface RemoteState {
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  /** Present when the source tool searches server-side; local filtering is then disabled. */
  onQueryChange?: (query: string) => void;
}

interface BaseProps {
  id: string;
  items: Option[];
  remote?: RemoteState;
  placeholder?: string;
  invalid?: boolean;
  disabled?: boolean;
}

export type OptionComboboxProps =
  | (BaseProps & { multiple?: false; value: Option | undefined; onChange: (value: Option | undefined) => void })
  | (BaseProps & { multiple: true; value: Option[]; onChange: (value: Option[]) => void });

const optionProps = {
  itemToStringLabel: (option: Option) => option.label,
  itemToStringValue: (option: Option) => option.id,
  isItemEqualToValue: (a: Option, b: Option) => a.id === b.id,
};

/** shadcn (Base UI) Combobox for static multiselects and tool-backed selects, following the shadcn examples. */
export function OptionCombobox(props: OptionComboboxProps) {
  const { id, items, remote, placeholder, invalid, disabled } = props;
  const anchor = useComboboxAnchor();
  const serverSearch = Boolean(remote?.onQueryChange);

  const shared = {
    ...optionProps,
    items,
    autoHighlight: true,
    disabled,
    // Server-side search returns already-filtered items.
    filter: serverSearch ? null : undefined,
    onInputValueChange: (query: string, details: { reason: string }) => {
      // Only typing searches; selecting an item fills the input with its label and must not.
      if (remote?.onQueryChange) remote.onQueryChange(details.reason === "input-change" ? query : "");
    },
  };

  const content = (
    <ComboboxContent anchor={props.multiple ? anchor : undefined}>
      {remote?.loading && items.length > 0 && (
        <div className="flex items-center gap-2 px-3 pt-2 text-xs text-muted-foreground">
          <Loader2Icon className="size-3 animate-spin" /> Searching…
        </div>
      )}
      <ComboboxEmpty>
        {remote?.loading ? (
          <span className="flex items-center justify-center gap-2">
            <Loader2Icon className="size-4 animate-spin" /> Loading…
          </span>
        ) : remote?.error ? (
          <span className="flex items-center justify-center gap-2 text-destructive">
            {remote.error}
            <Button type="button" size="xs" variant="ghost" onClick={remote.onRetry}>
              <RotateCwIcon /> Retry
            </Button>
          </span>
        ) : (
          "No results."
        )}
      </ComboboxEmpty>
      <ComboboxList>
        {(item: Option) => (
          <ComboboxItem key={item.id} value={item}>
            {item.label}
          </ComboboxItem>
        )}
      </ComboboxList>
    </ComboboxContent>
  );

  if (props.multiple) {
    return (
      <Combobox {...shared} multiple value={props.value} onValueChange={(value: Option[]) => props.onChange(value)}>
        <ComboboxChips ref={anchor} className={disabled ? "pointer-events-none opacity-50" : undefined}>
          <ComboboxValue>
            {(values: Option[]) => (
              <Fragment>
                {values.map((option) => (
                  <ComboboxChip key={option.id} showRemove={!disabled}>
                    {option.label}
                  </ComboboxChip>
                ))}
                <ComboboxChipsInput
                  id={id}
                  placeholder={values.length ? undefined : placeholder}
                  aria-invalid={invalid || undefined}
                  disabled={disabled}
                />
              </Fragment>
            )}
          </ComboboxValue>
        </ComboboxChips>
        {content}
      </Combobox>
    );
  }

  return (
    <Combobox {...shared} value={props.value ?? null} onValueChange={(value: Option | null) => props.onChange(value ?? undefined)}>
      <ComboboxInput
        id={id}
        placeholder={placeholder ?? "Select…"}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        showClear={Boolean(props.value)}
      />
      {content}
    </Combobox>
  );
}
