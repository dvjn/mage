// Pages: login, and signup while password sign-up is open, when signed out; when signed in, the app shell with a space and its
// settings, its skills among them, a new thread's draft, a thread, the threads shared with you,
// and the organization's settings with its people, spaces and skills, opening on the last space
// used.
// Each side redirects to the other; signing in or up goes back to the page that asked for it, such
// as an invite link, which is open either way.

import { onlineManager, type QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";

import { AppShell, PageHeader } from "@/web/app/app-shell";
import { AuthFrame } from "@/web/auth/auth-frame";
import { InvitePage } from "@/web/guests/invite-page";
import { JoinPage } from "@/web/orgs/join-page";
import { LoginForm } from "@/web/auth/login-form";
import { OrgSkills } from "@/web/skills/skills";
import { OrgGeneral } from "@/web/orgs/org-general";
import { OrgMcpServer, OrgTools } from "@/web/agent/org-tools";
import { OrgPeople, peopleSearchSchema } from "@/web/orgs/org-people";
import { OrgSpaces, orgSpacesSearchSchema } from "@/web/spaces/org-spaces";
import { OrgProviders } from "@/web/models/org-providers";
import { OrgShell } from "@/web/settings/org-shell";
import { SharedPage, sharedSearchSchema } from "@/web/guests/shared-page";
import { SignupForm } from "@/web/auth/signup-form";
import { SpacePage, spaceSearchSchema } from "@/web/spaces/space-page";
import { spaceMembersSearchSchema } from "@/web/spaces/space-members";
import {
  SpaceGeneral,
  SpaceMembersPage,
  SpaceMcpServer,
  SpaceSettingsShell,
  SpaceSkillsPage,
  SpaceTools,
} from "@/web/spaces/space-settings";
import { DraftThread } from "@/web/threads/draft-thread";
import { ThreadPage } from "@/web/threads/thread-page";
import { lastSpace } from "@/web/spaces/last-space";
import { tabOrg } from "@/web/lib/org-tab";
import { lastSignedIn, restored } from "@/web/lib/query-cache";
import { meQuery, sessionQuery, signInOptionsQuery } from "@/web/auth/queries";
import { spacesQuery } from "@/web/spaces/queries";

type Context = { context: { queryClient: QueryClient } };

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Outlet,
});

// Where to go after signing in or up: a path in this app, never another site; and the email to
// sign in or up with, as an org invite gives it.
export function afterSignIn(search: Record<string, unknown>): {
  redirect?: string;
  email?: string;
} {
  const { redirect, email } = search;
  return {
    ...(typeof redirect === "string" && /^\/(?![/\\])/.test(redirect) && { redirect }),
    ...(typeof email === "string" && { email }),
  };
}

async function redirectIfSignedIn({
  context,
  location,
}: Context & { location: { search: Record<string, unknown> } }) {
  // Offline, whoever signed in last reads what was kept for them.
  const signedIn = await context.queryClient
    .fetchQuery(sessionQuery)
    .catch((error: unknown) => lastSignedIn(error).catch(() => null));
  if (!signedIn) return;
  const { redirect: back } = afterSignIn(location.search);
  throw back ? redirect({ href: back }) : redirect({ to: "/" });
}

// While the server cannot be reached, whoever signed in last reads what was kept for them.
async function requireSession({ context }: Context) {
  const session = await context.queryClient.fetchQuery(sessionQuery).catch(lastSignedIn);
  if (!session) throw redirect({ to: "/login" });
  // A tab that does not know its org yet takes the one the server chose before anything shows, so
  // its pages stay in that org whatever the session does next.
  if (!tabOrg()) await context.queryClient.fetchQuery(meQuery);
}

const signedOutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "_signed-out",
  beforeLoad: redirectIfSignedIn,
  component: () => (
    <AuthFrame>
      <Outlet />
    </AuthFrame>
  ),
});

// `error` is what the identity provider's sign-in ended with, when it failed.
const loginRoute = createRoute({
  getParentRoute: () => signedOutRoute,
  path: "/login",
  validateSearch: (search: Record<string, unknown>) => ({
    ...afterSignIn(search),
    ...(typeof search.error === "string" && { error: search.error }),
  }),
  component: LoginForm,
});

// Password sign-up is open only while there is no identity provider.
const signupRoute = createRoute({
  getParentRoute: () => signedOutRoute,
  path: "/signup",
  validateSearch: afterSignIn,
  beforeLoad: async ({ context, search }) => {
    const options = await context.queryClient.fetchQuery(signInOptionsQuery);
    if (options.oidc) throw redirect({ to: "/login", search });
  },
  component: SignupForm,
});

// Opens an invite link: signed out, it asks to sign in or up first; signed in, it lets the person
// into the thread.
const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invite/$token",
  component: InvitePage,
});

// Opens an org invite link: signed out, it asks to sign in or up with its email first; signed in as
// its person, it lets them into the org.
const joinRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/join/$token",
  component: JoinPage,
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "_app",
  beforeLoad: requireSession,
  component: AppShell,
});

// Opens the space used last in this browser, or the first one.
const homeRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  beforeLoad: async ({ context }) => {
    // Offline, the spaces kept from before.
    const spaces = (
      onlineManager.isOnline()
        ? await context.queryClient.fetchQuery(spacesQuery)
        : await restored.then(() => context.queryClient.getQueryData(spacesQuery.queryKey) ?? [])
    ).filter((s) => s.role);
    const last = lastSpace();
    const space = spaces.find((s) => s.id === last) ?? spaces[0];
    if (space) throw redirect({ to: "/s/$spaceId", params: { spaceId: space.id } });
  },
  component: () => <PageHeader crumbs={[{ label: "No spaces" }]} />,
});

// The threads narrowed to the folder in `?folder=`, to those that need the reader or have something
// new for them in `?show=`, and by `?q=`, on the page in `?page=` of `?perPage=`.
const spaceRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/s/$spaceId",
  validateSearch: spaceSearchSchema,
  component: SpacePage,
});

// A space's settings, in pages beside a list of them.
const spaceSettingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/s/$spaceId/settings",
  component: SpaceSettingsShell,
});

const spaceGeneralRoute = createRoute({
  getParentRoute: () => spaceSettingsRoute,
  path: "/",
  component: SpaceGeneral,
});

// The members' search in `?q=`, role in `?role=` and page.
const spaceMembersRoute = createRoute({
  getParentRoute: () => spaceSettingsRoute,
  path: "/members",
  validateSearch: spaceMembersSearchSchema,
  component: SpaceMembersPage,
});

const spaceSkillsRoute = createRoute({
  getParentRoute: () => spaceSettingsRoute,
  path: "/skills",
  component: SpaceSkillsPage,
});

const spaceToolsRoute = createRoute({
  getParentRoute: () => spaceSettingsRoute,
  path: "/tools",
  component: SpaceTools,
});

// One of the space's own MCP servers.
const spaceMcpServerRoute = createRoute({
  getParentRoute: () => spaceSettingsRoute,
  path: "/tools/mcp/$serverId",
  component: SpaceMcpServer,
});

// A thread not made yet, at the top of the space or in `?folder=`.
const draftRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/s/$spaceId/new",
  validateSearch: (search: Record<string, unknown>): { folder?: string } =>
    typeof search.folder === "string" ? { folder: search.folder } : {},
  component: DraftThread,
});

const threadRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/t/$threadId",
  component: ThreadPage,
});

// The threads narrowed as on a space's page, in `?show=` and `?q=`, and their page.
const sharedRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/shared",
  validateSearch: sharedSearchSchema,
  component: SharedPage,
});

// The organization's settings, opening on its general page; /settings leads there too.
const orgRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/org",
  component: OrgShell,
});

const orgIndexRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/org/general" });
  },
});

const orgGeneralRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/general",
  component: OrgGeneral,
});

const orgSkillsRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/skills",
  component: OrgSkills,
});

const orgToolsRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/tools",
  component: OrgTools,
});

// One of the org's MCP servers.
const orgMcpServerRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/tools/mcp/$serverId",
  component: OrgMcpServer,
});

const orgProvidersRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/providers",
  component: OrgProviders,
});

// Its people: the search in `?q=`, the role and status in `?role=` and `?status=`, and the page.
const orgPeopleRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/people",
  validateSearch: peopleSearchSchema,
  component: OrgPeople,
});

// The search in `?q=`, the kind and everyone's role in `?kind=` and `?everyone=`, and the page.
const orgSpacesRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/spaces",
  validateSearch: orgSpacesSearchSchema,
  component: OrgSpaces,
});

const orgMembersRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/members",
  beforeLoad: () => {
    throw redirect({ to: "/org/people" });
  },
});

const orgGroupsRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/groups",
  beforeLoad: () => {
    throw redirect({ to: "/org/people" });
  },
});

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings",
  beforeLoad: () => {
    throw redirect({ to: "/org/general" });
  },
});

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree: rootRoute.addChildren([
      signedOutRoute.addChildren([loginRoute, signupRoute]),
      inviteRoute,
      joinRoute,
      appRoute.addChildren([
        homeRoute,
        spaceRoute,
        spaceSettingsRoute.addChildren([
          spaceGeneralRoute,
          spaceMembersRoute,
          spaceToolsRoute,
          spaceSkillsRoute,
          spaceMcpServerRoute,
        ]),
        draftRoute,
        threadRoute,
        sharedRoute,
        orgRoute.addChildren([
          orgIndexRoute,
          orgGeneralRoute,
          orgProvidersRoute,
          orgToolsRoute,
          orgSkillsRoute,
          orgMcpServerRoute,
          orgPeopleRoute,
          orgSpacesRoute,
          orgMembersRoute,
          orgGroupsRoute,
        ]),
        settingsRoute,
      ]),
    ]),
    context: { queryClient },
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
