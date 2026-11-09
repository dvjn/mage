// The card that allows public artifacts for the org, or for one of its spaces, shown only to those
// who may change it. A space's switch says when the org's is off, which outweighs it.

import { useQuery } from "@tanstack/react-query";
import { useId } from "react";

import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/web/components/ui/field";
import { Switch } from "@/web/components/ui/switch";
import { orgArtifactSettingsQuery, spaceArtifactSettingsQuery } from "@/web/artifacts/queries";
import { useAllowPublic } from "@/web/artifacts/mutations";
import { SettingsCard } from "@/web/shell/settings-page";

export function AllowPublicArtifacts({ spaceId }: { spaceId?: string }) {
  const id = useId();
  const settings = useQuery(
    spaceId ? spaceArtifactSettingsQuery(spaceId) : orgArtifactSettingsQuery,
  );
  const change = useAllowPublic(spaceId);
  if (!settings.data?.canManage) return null;
  const orgOff = !!spaceId && !settings.data.orgPublicAllowed;
  return (
    <SettingsCard title="Artifacts">
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor={id}>Allow public artifacts</FieldLabel>
          <FieldDescription>
            {orgOff
              ? "Off for the organization, so none here can be public."
              : "Artifacts can be shared with anyone who has the link."}
          </FieldDescription>
          <FieldError>{change.error?.message}</FieldError>
        </FieldContent>
        <Switch
          id={id}
          checked={settings.data.publicAllowed}
          disabled={change.isPending}
          onCheckedChange={(checked) => change.mutate(checked)}
        />
      </Field>
    </SettingsCard>
  );
}
