// The agent's skills in settings, on a page of their own for the org and for a space.

import { useQuery } from "@tanstack/react-query";

import { SettingsTitle } from "@/web/shell/settings-page";
import { meQuery } from "@/web/auth/queries";
import { orgSkillsQuery, spaceSkillsQuery } from "@/web/skills/queries";
import { SkillsCard } from "@/web/skills/card";

// The org's Skills page.
export function OrgSkills() {
  const me = useQuery(meQuery);
  const canManage = me.data?.role === "owner";
  const agent = useQuery(orgSkillsQuery);
  const data = agent.data;
  return (
    <>
      <SettingsTitle
        title="Skills"
        description={
          canManage
            ? "What the agent can load in every space."
            : "What the agent can load in every space. Only the organization's owners change this."
        }
      />
      <SkillsCard
        scope={{ kind: "org" }}
        state={agent}
        sources={(data?.sources ?? []).map((source) => ({ source, locked: false }))}
        written={(data?.written ?? []).map((skill) => ({ skill, locked: false }))}
        canManage={canManage}
        allowed
        spaceSkills={data?.spaceSkills ?? null}
      />
    </>
  );
}

// A space's Skills page: the org's, with the space's switches, and its own.
export function SpaceSkills({ spaceId }: { spaceId: string }) {
  const agent = useQuery(spaceSkillsQuery(spaceId));
  const data = agent.data;
  return (
    <>
      <SettingsTitle title="Skills" description="What the agent can load in this space." />
      <SkillsCard
        scope={{ kind: "space", spaceId }}
        state={agent}
        sources={[
          ...(data?.org.sources ?? []).map((source) => ({ source, locked: true })),
          ...(data?.own.sources ?? []).map((source) => ({ source, locked: false })),
        ]}
        written={[
          ...(data?.org.written ?? []).map((skill) => ({ skill, locked: true })),
          ...(data?.own.written ?? []).map((skill) => ({ skill, locked: false })),
        ]}
        canManage
        allowed={data?.allowed ?? true}
        spaceSkills={null}
      />
    </>
  );
}
