// Renders an artifact's page in a headless browser for the agent to check: at desktop and phone
// width, in light and dark, reporting what overflows sideways, colours that stay the same in both
// themes, loads the page's policy blocked and console errors. The page and its files are answered
// in process; anything else it loads goes to the network as a viewer's browser would send it.
// Chromium comes with the browser journeys' tooling, so servers without it offer no previews.

export interface PreviewReport {
  renders: {
    viewport: "desktop" | "phone";
    width: number;
    theme: "light" | "dark";
    // How wide the page is when wider than the viewport, and the elements reaching past it.
    overflow: { scrollWidth: number; elements: string[] } | null;
  }[];
  // Per width, elements whose text or background colour is the same in light and dark.
  themeIgnored: { viewport: "desktop" | "phone"; elements: string[] }[];
  blocked: { url: string; directive: string }[];
  consoleErrors: string[];
}

export interface PreviewPage {
  url: string;
  // Answers the page's own requests.
  handle: (request: Request) => Promise<Response>;
  signal?: AbortSignal;
}

export interface ArtifactPreviewer {
  preview(page: PreviewPage): Promise<PreviewReport>;
}

const VIEWPORTS = [
  { viewport: "desktop", width: 1280, height: 800 },
  { viewport: "phone", width: 390, height: 844 },
] as const;
const THEMES = ["light", "dark"] as const;

// How long a page may take to load, and to settle after.
const LOAD_TIMEOUT_MS = 15_000;
const SETTLE_MS = 300;
// The most of each finding reported.
const LISTED = 10;

// Read in the page: elements past the right edge, and each visible element's colours.
const MEASURE = `(() => {
  const name = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") +
    (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".") : "");
  const width = document.documentElement.clientWidth;
  const all = [...document.body.querySelectorAll("*")].slice(0, 2000);
  const wide = all.filter((el) => el.getBoundingClientRect().right > width + 1).map(name);
  const colours = {};
  all.forEach((el, index) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const style = getComputedStyle(el);
    colours[index + ":" + name(el)] = style.color + "|" + style.backgroundColor;
  });
  const root = getComputedStyle(document.body);
  colours["body"] = root.color + "|" + root.backgroundColor;
  return { scrollWidth: document.documentElement.scrollWidth, width, wide, colours };
})()`;

const TRACK_VIOLATIONS = `addEventListener("securitypolicyviolation", (event) => {
  (window.__violations ??= []).push({ url: event.blockedURI, directive: event.effectiveDirective });
});`;

type Playwright = typeof import("@playwright/test");

// A previewer on headless Chromium, or null where it cannot be loaded.
export async function loadChromiumPreviewer(): Promise<ArtifactPreviewer | null> {
  // Named at run time, so builds leave it out.
  const name = "@playwright/test";
  let playwright: Playwright;
  try {
    playwright = (await import(/* @vite-ignore */ name)) as Playwright;
  } catch {
    return null;
  }
  return {
    async preview({ url, handle, signal }) {
      const origin = new URL(url).origin;
      const browser = await playwright.chromium.launch();
      const stop = () => void browser.close();
      signal?.addEventListener("abort", stop, { once: true });
      const blocked = new Map<string, { url: string; directive: string }>();
      const consoleErrors = new Set<string>();
      const renders: PreviewReport["renders"] = [];
      const themeIgnored: PreviewReport["themeIgnored"] = [];
      try {
        for (const size of VIEWPORTS) {
          const colours: Record<string, string>[] = [];
          for (const theme of THEMES) {
            const context = await browser.newContext({
              viewport: { width: size.width, height: size.height },
              colorScheme: theme,
            });
            await context.route(`${origin}/**`, async (route) => {
              const request = route.request();
              const response = await handle(
                new Request(request.url(), {
                  method: request.method(),
                  headers: request.headers(),
                }),
              );
              await route.fulfill({
                status: response.status,
                headers: Object.fromEntries(response.headers),
                body: Buffer.from(await response.arrayBuffer()),
              });
            });
            const page = await context.newPage();
            await page.addInitScript(TRACK_VIOLATIONS);
            page.on("console", (message) => {
              if (message.type() === "error") consoleErrors.add(message.text());
            });
            page.on("pageerror", (error) => consoleErrors.add(error.message));
            const themed = new URL(url);
            themed.searchParams.set("theme", theme);
            await page.goto(themed.href, { waitUntil: "load", timeout: LOAD_TIMEOUT_MS });
            await page.waitForTimeout(SETTLE_MS);
            const measured = (await page.evaluate(MEASURE)) as {
              scrollWidth: number;
              width: number;
              wide: string[];
              colours: Record<string, string>;
            };
            const violations = (await page.evaluate("window.__violations ?? []")) as {
              url: string;
              directive: string;
            }[];
            for (const violation of violations) {
              blocked.set(`${violation.directive} ${violation.url}`, violation);
            }
            renders.push({
              viewport: size.viewport,
              width: size.width,
              theme,
              overflow:
                measured.scrollWidth > measured.width
                  ? {
                      scrollWidth: measured.scrollWidth,
                      elements: [...new Set(measured.wide)].slice(0, LISTED),
                    }
                  : null,
            });
            colours.push(measured.colours);
            await context.close();
          }
          const [light = {}, dark = {}] = colours;
          const same = Object.keys(light)
            .filter((key) => dark[key] === light[key])
            .map((key) => key.slice(key.indexOf(":") + 1));
          if (same.length > 0) {
            themeIgnored.push({
              viewport: size.viewport,
              elements: [...new Set(same)].slice(0, LISTED),
            });
          }
        }
      } finally {
        signal?.removeEventListener("abort", stop);
        await browser.close();
      }
      return {
        renders,
        themeIgnored,
        blocked: [...blocked.values()].slice(0, LISTED),
        consoleErrors: [...consoleErrors].slice(0, LISTED),
      };
    },
  };
}
