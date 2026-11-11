// What someone given access, or a role, may do, as the levels of the access toggle group: View or
// Message on a thread, View or Edit on an artifact, Member or Owner in an org, View, Message or
// Owner in a space. Every place that gives access or a role offers them the same way.

import { BanIcon, CrownIcon, EyeIcon, MessageSquareIcon, PencilIcon, UserIcon } from "lucide-react";
import type { Level } from "@/web/components/access-level";

export const THREAD_LEVELS = [
  { value: "view", label: "View", icon: EyeIcon },
  { value: "message", label: "Message", icon: MessageSquareIcon },
] as const satisfies readonly Level<string>[];

export const ARTIFACT_LEVELS = [
  { value: "view", label: "View", icon: EyeIcon },
  { value: "edit", label: "Edit", icon: PencilIcon },
] as const satisfies readonly Level<string>[];

export const ORG_ROLE_LEVELS = [
  { value: "member", label: "Member", icon: UserIcon },
  { value: "owner", label: "Owner", icon: CrownIcon },
] as const satisfies readonly Level<string>[];

export const SPACE_ROLE_LEVELS = [
  { value: "viewer", label: "View", icon: EyeIcon },
  { value: "messager", label: "Message", icon: MessageSquareIcon },
  { value: "owner", label: "Owner", icon: CrownIcon },
] as const satisfies readonly Level<string>[];

// What everyone in the org gets from a shared space; owning is not for everyone. None goes last,
// in Owner's place, so View and Message line up with the members' below.
export const EVERYONE_LEVELS = [
  { value: "viewer", label: "View", icon: EyeIcon },
  { value: "messager", label: "Message", icon: MessageSquareIcon },
  { value: "none", label: "None", icon: BanIcon },
] as const satisfies readonly Level<string>[];
