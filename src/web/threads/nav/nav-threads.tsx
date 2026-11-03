// The sidebar's space and threads sections for the place open: a space's, or the threads shared
// with the person.

import { usePlace } from "@/web/spaces/active-space";
import { SharedThreads } from "@/web/threads/nav/shared-threads";
import { SpaceSection } from "@/web/threads/nav/space-section";
import { SpaceThreads } from "@/web/threads/nav/space-threads";

export function NavThreads() {
  const place = usePlace();
  if (!place) return null;
  if (place.kind === "shared") return <SharedThreads />;
  // An archived space's threads are only on its page.
  if (place.space.archived) return null;
  // A space its org's owner manages without being in it shows them only its settings.
  if (place.space.role === null) return <SpaceSection space={place.space} />;
  return <SpaceThreads key={place.space.id} space={place.space} />;
}
