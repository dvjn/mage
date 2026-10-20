// Pages: login and signup when signed out, home and settings when signed in; each redirects to the
// other side.

import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";

import { Home } from "@/web/components/home";
import { LoginForm } from "@/web/components/login-form";
import { Settings } from "@/web/components/settings";
import { SignupForm } from "@/web/components/signup-form";
import { sessionQuery } from "@/web/lib/queries";

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: () => (
    <main className="flex min-h-svh items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <Outlet />
      </div>
    </main>
  ),
});

async function redirectIfSignedIn({ context }: { context: { queryClient: QueryClient } }) {
  if (await context.queryClient.fetchQuery(sessionQuery)) throw redirect({ to: "/" });
}

async function requireSession({ context }: { context: { queryClient: QueryClient } }) {
  const session = await context.queryClient.fetchQuery(sessionQuery);
  if (!session) throw redirect({ to: "/login" });
  return { session };
}

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: requireSession,
  component: Home,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  beforeLoad: requireSession,
  component: Settings,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  beforeLoad: redirectIfSignedIn,
  component: LoginForm,
});

const signupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/signup",
  beforeLoad: redirectIfSignedIn,
  component: SignupForm,
});

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree: rootRoute.addChildren([homeRoute, settingsRoute, loginRoute, signupRoute]),
    context: { queryClient },
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
