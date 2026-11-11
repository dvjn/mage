// The card that allows public artifacts for the org, or for one of its spaces, shown only to those
// who may change it. A space's switch says when the org's is off, which outweighs it.

import { useQuery } from "@tanstack/react-query";
import { orgArtifactSettingsQuery, spaceArtifactSettingsQuery } from "@/web/artifacts/queries";
import { useAllowPublic } from "@/web/artifacts/mutations";
import { SettingsCard } from "@/web/shell/settings-page";
import { SettingsSwitch } from "@/web/shell/settings-switch";

export function AllowPublicArtifacts({ spaceId }: { spaceId?: string }) {
  const settings = useQuery(
    spaceId ? spaceArtifactSettingsQuery(spaceId) : orgArtifactSettingsQuery,
  );
  const change = useAllowPublic(spaceId);
  if (!settings.data?.canManage) return null;
  const orgOff = !!spaceId && !settings.data.orgPublicAllowed;
  return (
    <SettingsCard title="Artifacts">
      <SettingsSwitch
        label="Allow public artifacts"
        description={
          orgOff
            ? "Off for the organization, so none here can be public."
            : "Artifacts can be shared with anyone who has the link."
        }
        checked={settings.data.publicAllowed}
        disabled={change.isPending}
        error={change.error?.message}
        onChange={(checked) => change.mutate(checked)}
      />
    </SettingsCard>
  );
}
