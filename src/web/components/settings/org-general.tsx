// The organization's general settings: its name, and the models its threads start with and that
// name them.

import { useQuery } from "@tanstack/react-query";
import { useId } from "react";

import { SettingsCard, SettingsTitle } from "@/web/components/settings/layout";
import { ModelsCard } from "@/web/components/settings/models-card";
import { Field, FieldDescription, FieldLabel } from "@/web/components/ui/field";
import { Input } from "@/web/components/ui/input";
import { meQuery } from "@/web/lib/queries";

export function OrgGeneral() {
  const id = useId();
  const me = useQuery(meQuery);
  const role = me.data?.role;
  const personal = me.data?.org.kind === "personal";
  return (
    <>
      <SettingsTitle
        title="General"
        description={me.data ? `Settings for everyone in ${me.data.org.name}.` : undefined}
      />
      <SettingsCard title="Organization" state={me}>
        <Field>
          <FieldLabel htmlFor={id}>Organization name</FieldLabel>
          <Input id={id} value={me.data?.org.name ?? ""} readOnly disabled />
          {personal && (
            <FieldDescription>
              Your personal organization is named after you and only has you.
            </FieldDescription>
          )}
        </Field>
      </SettingsCard>
      <ModelsCard canManage={role === "owner" || role === "admin"} />
    </>
  );
}
