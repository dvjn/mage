// Pages: login, and signup while password sign-up is open, when signed out; when signed in, the app shell with a space and its
// settings, a new thread's draft, a thread, the threads shared with you, and the organization's
// settings with its people and spaces, opening on the last space used.
// Each side redirects to the other; signing in or up goes back to the page that asked for it, such
// as an invite link, which is open either way.

import type { QueryClient } from "@tanstack/react-query";

import type { SpaceRole } from "@/shared/spaces.ts";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";

import { AppShell, PageHeader } from "@/web/components/app-shell";
import { AuthFrame } from "@/web/components/auth-frame";
import { InvitePage } from "@/web/components/invite-page";
import { JoinPage } from "@/web/components/join-page";
import { LoginForm } from "@/web/components/login-form";
import { OrgGeneral } from "@/web/components/settings/org-general";
import { OrgPeople, type PeopleSearch } from "@/web/components/settings/org-people";
import { OrgSpaces, type OrgSpacesSearch } from "@/web/components/settings/org-spaces";
import { OrgProviders } from "@/web/components/settings/org-providers";
import { OrgShell } from "@/web/components/settings/org-shell";
import { SharedPage } from "@/web/components/shared-page";
import { SignupForm } from "@/web/components/signup-form";
import { SpacePage } from "@/web/components/space-page";
import { SpaceSettings } from "@/web/components/space-settings";
import { DraftThread } from "@/web/components/draft-thread";
import { ThreadPage } from "@/web/components/thread-page";
import { lastSpace } from "@/web/lib/last-space";
import { sessionQuery, signInOptionsQuery, spacesQuery } from "@/web/lib/queries";

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
  if (!(await context.queryClient.fetchQuery(sessionQuery))) return;
  const { redirect: back } = afterSignIn(location.search);
  throw back ? redirect({ href: back }) : redirect({ to: "/" });
}

async function requireSession({ context }: Context) {
  const session = await context.queryClient.fetchQuery(sessionQuery);
  if (!session) throw redirect({ to: "/login" });
  return { session };
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

// Password sign-up is open only when everyone may sign in with a password.
const signupRoute = createRoute({
  getParentRoute: () => signedOutRoute,
  path: "/signup",
  validateSearch: afterSignIn,
  beforeLoad: async ({ context, search }) => {
    const options = await context.queryClient.fetchQuery(signInOptionsQuery);
    if (options.password !== "everyone") throw redirect({ to: "/login", search });
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
    const spaces = (await context.queryClient.fetchQuery(spacesQuery)).filter((s) => s.role);
    const last = lastSpace();
    const space = spaces.find((s) => s.id === last) ?? spaces[0];
    if (space) throw redirect({ to: "/s/$spaceId", params: { spaceId: space.id } });
  },
  component: () => <PageHeader crumbs={[{ label: "No spaces" }]} />,
});

// The threads narrowed to the folder in `?folder=`.
const spaceRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/s/$spaceId",
  validateSearch: (search: Record<string, unknown>): { folder?: string } =>
    typeof search.folder === "string" ? { folder: search.folder } : {},
  component: SpacePage,
});

const spaceSettingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/s/$spaceId/settings",
  // The members' search in `?q=` and role in `?role=`.
  validateSearch: (search: Record<string, unknown>): { q?: string; role?: SpaceRole } => ({
    ...textOf(search),
    ...((search.role === "owner" || search.role === "messager" || search.role === "viewer") && {
      role: search.role,
    }),
  }),
  component: SpaceSettings,
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

const sharedRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/shared",
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

const orgProvidersRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/providers",
  component: OrgProviders,
});

// Text in `?q=`, or empty.
function textOf(search: Record<string, unknown>) {
  return typeof search.q === "string" && search.q ? { q: search.q } : {};
}

// Its people: the search in `?q=`, and the role and status in `?role=` and `?status=`.
const orgPeopleRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/people",
  validateSearch: (search: Record<string, unknown>): PeopleSearch => ({
    ...textOf(search),
    ...((search.role === "owner" || search.role === "member") && { role: search.role }),
    ...((search.status === "member" || search.status === "invited") && { status: search.status }),
  }),
  component: OrgPeople,
});

// The search in `?q=`, and the kind and everyone's role in `?kind=` and `?everyone=`.
const orgSpacesRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/spaces",
  validateSearch: (search: Record<string, unknown>): OrgSpacesSearch => ({
    ...textOf(search),
    ...((search.kind === "shared" || search.kind === "personal") && { kind: search.kind }),
    ...((search.everyone === "none" ||
      search.everyone === "viewer" ||
      search.everyone === "messager") && { everyone: search.everyone }),
  }),
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
        spaceSettingsRoute,
        draftRoute,
        threadRoute,
        sharedRoute,
        orgRoute.addChildren([
          orgIndexRoute,
          orgGeneralRoute,
          orgProvidersRoute,
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
