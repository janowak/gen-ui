import type { ResourceSource } from "@app-mcp/format";
import type { App } from "@modelcontextprotocol/ext-apps";
import { useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { OptionCombobox, type OptionComboboxProps } from "./OptionCombobox";
import { useOptions } from "./useOptions";

type Props = Omit<OptionComboboxProps, "items" | "remote"> & {
  app: App | null;
  source: ResourceSource;
  /** False until the server has approved the source tool. */
  ready: boolean;
};

/** Select whose options come from a tool call (ResourceSelect / ResourceMultiSelect). */
export function ResourceSelect({ app, source, ready, ...combobox }: Props) {
  const [query, setQuery] = useState("");
  // Loads as soon as the source is approved, so the first open is instant.
  const { options, loading, error, retry } = useOptions(app, source, query, ready);

  if (!ready) return <Skeleton className="h-8 w-full" />;

  return (
    <OptionCombobox
      {...(combobox as OptionComboboxProps)}
      items={options}
      remote={{ loading, error, onRetry: retry, onQueryChange: source.searchParam ? setQuery : undefined }}
    />
  );
}
