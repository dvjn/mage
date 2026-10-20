// Pages: login and signup when signed out; when signed in, the app shell with a space, a thread
// and settings, opening on the last space used. Each side redirects to the other.

import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";

import { AppShell, PageHeader } from "@/web/components/app-shell";
import { LoginForm } from "@/web/components/login-form";
import { Settings } from "@/web/components/settings";
import { SignupForm } from "@/web/components/signup-form";
import { SpacePage } from "@/web/components/space-page";
import { ThreadPage } from "@/web/components/thread-page";
import { lastSpace } from "@/web/lib/last-space";
import { sessionQuery, spacesQuery } from "@/web/lib/queries";

type Context = { context: { queryClient: QueryClient } };

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Outlet,
});

async function redirectIfSignedIn({ context }: Context) {
  if (await context.queryClient.fetchQuery(sessionQuery)) throw redirect({ to: "/" });
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
  component: LoginForm,
});

const signupRoute = createRoute({
  getParentRoute: () => signedOutRoute,
  path: "/signup",
  component: SignupForm,
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

const threadRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/t/$threadId",
  component: ThreadPage,
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
      appRoute.addChildren([homeRoute, spaceRoute, threadRoute, settingsRoute]),
    ]),
    context: { queryClient },
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
