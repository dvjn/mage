// The role someone or a group has in the org, as a select.

import { ORG_ROLE_LABELS, type OrgRole } from "@/shared/orgs.ts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/web/components/ui/select";

const ROLES: OrgRole[] = ["member", "owner"];

export const ROLE_OPTIONS = ROLES.map((value) => ({ value, label: ORG_ROLE_LABELS[value] }));

export function OrgRoleSelect({
  value,
  onChange,
  label,
}: {
  value: OrgRole;
  onChange: (role: OrgRole) => void;
  label: string;
}) {
  return (
    <Select value={value} onValueChange={(next) => next && onChange(next as OrgRole)}>
      <SelectTrigger size="sm" aria-label={label} className="w-28">
        <SelectValue>{(role: OrgRole) => ORG_ROLE_LABELS[role]}</SelectValue>
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {ROLE_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
