// Pages: login and signup when signed out; when signed in, the app shell with a space and its
// settings, a thread, the threads shared with you and settings, opening on the last space used.
// Each side redirects to the other; signing in or up goes back to the page that asked for it, such
// as an invite link, which is open either way.

import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";

import { AppShell, PageHeader } from "@/web/components/app-shell";
import { InvitePage } from "@/web/components/invite-page";
import { LoginForm } from "@/web/components/login-form";
import { Settings } from "@/web/components/settings";
import { SharedPage } from "@/web/components/shared-page";
import { SignupForm } from "@/web/components/signup-form";
import { SpacePage } from "@/web/components/space-page";
import { SpaceSettings } from "@/web/components/space-settings";
import { ThreadPage } from "@/web/components/thread-page";
import { lastSpace } from "@/web/lib/last-space";
import { sessionQuery, spacesQuery } from "@/web/lib/queries";

type Context = { context: { queryClient: QueryClient } };

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Outlet,
});

// Where to go after signing in or up: a path in this app, never another site.
export function afterSignIn(search: Record<string, unknown>): { redirect?: string } {
  const { redirect } = search;
  return typeof redirect === "string" && /^\/(?![/\\])/.test(redirect) ? { redirect } : {};
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
    <main className="flex min-h-svh items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <Outlet />
      </div>
    </main>
  ),
});

const loginRoute = createRoute({
  getParentRoute: () => signedOutRoute,
  path: "/login",
  validateSearch: afterSignIn,
  component: LoginForm,
});

const signupRoute = createRoute({
  getParentRoute: () => signedOutRoute,
  path: "/signup",
  validateSearch: afterSignIn,
  component: SignupForm,
});

// Opens an invite link: signed out, it asks to sign in or up first; signed in, it lets the person
// into the thread.
const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invite/$token",
  component: InvitePage,
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
    const spaces = await context.queryClient.fetchQuery(spacesQuery);
    const last = lastSpace();
    const space = spaces.find((s) => s.id === last) ?? spaces[0];
    if (space) throw redirect({ to: "/s/$spaceId", params: { spaceId: space.id } });
  },
  component: () => <PageHeader crumbs={[{ label: "No spaces" }]} />,
});

const spaceRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/s/$spaceId",
  component: SpacePage,
});

const spaceSettingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/s/$spaceId/settings",
  component: SpaceSettings,
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

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings",
  component: Settings,
});

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree: rootRoute.addChildren([
      signedOutRoute.addChildren([loginRoute, signupRoute]),
      inviteRoute,
      appRoute.addChildren([
        homeRoute,
        spaceRoute,
        spaceSettingsRoute,
        threadRoute,
        sharedRoute,
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
