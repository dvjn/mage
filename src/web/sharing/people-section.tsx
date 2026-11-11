// The people a thread or an artifact is shared with: the person row each, what they may do where
// the reader may change it, and Remove where the server lets the reader, which asks first when the
// row says so.
// A long list gets a filter. What adds people is the caller's, shown below the rows.

import { type ReactNode, useState } from "react";

import { EmptyState } from "@/web/components/page-states";
import { FieldLabel } from "@/web/components/ui/field";
import { FilterInput } from "@/web/components/filter-input";
import {
  RemoveButton,
  RemoveConfirm,
  removalCopy,
  type SubjectAvatar,
} from "@/web/shell/people-table";
import { Suggestion } from "@/web/spaces/subject-picker";

export interface PersonRow {
  id: string;
  // What the row is called to assistive tools.
  label: string;
  avatar: SubjectAvatar;
  name: string;
  you?: boolean;
  detail?: ReactNode;
  // What they may do, as an access level, where it may be changed.
  control?: ReactNode;
  // Asked before removing, as a person or as a group; none removes at once.
  confirm?: "person" | "group";
  onRemove?: () => void;
  disabled?: boolean;
}

// Above this many rows the list gets a filter.
const FILTER_FROM = 8;

export function PeopleSection({
  rows,
  empty,
  add,
}: {
  rows: PersonRow[];
  // Shown when there are no rows.
  empty?: string;
  add: ReactNode;
}) {
  const [filter, setFilter] = useState("");
  const [confirming, setConfirming] = useState<PersonRow | null>(null);
  const needle = filter.trim().toLowerCase();
  const shown = rows.filter((row) => row.name.toLowerCase().includes(needle));
  const filtering = rows.length > FILTER_FROM;
  return (
    <section aria-label="People" className="flex flex-col gap-1">
      <FieldLabel>People</FieldLabel>
      {filtering && <FilterInput label="Filter people" value={filter} onChange={setFilter} />}
      <ul aria-label="People with access" className="flex max-h-80 flex-col overflow-y-auto">
        {shown.map((row) => (
          <Suggestion
            key={row.id}
            label={row.label}
            avatar={row.avatar}
            name={row.name}
            you={row.you}
            detail={row.detail}
          >
            {row.control}
            {row.onRemove && (
              <RemoveButton
                name={row.name}
                disabled={row.disabled}
                onClick={() => (row.confirm ? setConfirming(row) : row.onRemove?.())}
              />
            )}
          </Suggestion>
        ))}
        {rows.length === 0 && empty && (
          <li>
            <EmptyState compact title={empty} />
          </li>
        )}
        {filtering && shown.length === 0 && (
          <li>
            <EmptyState compact title="No matches" />
          </li>
        )}
      </ul>
      {add}
      <RemoveConfirm
        subject={confirming?.confirm ? removalCopy(confirming.confirm, confirming.name) : null}
        onClose={() => setConfirming(null)}
        onConfirm={() => {
          confirming?.onRemove?.();
          setConfirming(null);
        }}
      />
    </section>
  );
}
