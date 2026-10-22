import { format, isValid, parse } from "date-fns";
import { CalendarIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const ISO = "yyyy-MM-dd";

interface Props {
  id: string;
  /** ISO date (YYYY-MM-DD), as submitted. */
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  placeholder?: string;
  invalid?: boolean;
  disabled?: boolean;
}

/** shadcn date picker (Popover + Calendar), following the shadcn "Date Picker Simple" example. */
export function DatePicker({ id, value, onChange, placeholder, invalid, disabled }: Props) {
  const [open, setOpen] = useState(false);
  // Parse as a local date: new Date("YYYY-MM-DD") would be UTC and can shift a day.
  const parsed = value ? parse(value, ISO, new Date()) : undefined;
  const selected = parsed && isValid(parsed) ? parsed : undefined;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            id={id}
            disabled={disabled}
            aria-invalid={invalid || undefined}
            className="w-full justify-start px-2.5 font-normal"
          />
        }
      >
        <CalendarIcon data-icon="inline-start" />
        {selected ? format(selected, "PPP") : <span className="text-muted-foreground">{placeholder ?? "Pick a date"}</span>}
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={selected}
          defaultMonth={selected}
          onSelect={(date) => {
            onChange(date ? format(date, ISO) : undefined);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
