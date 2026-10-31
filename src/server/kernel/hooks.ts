// Named points where a feature announces what it did, for any other feature to add to it within the
// same call, in the order they registered; a failing listener fails the whole. Each feature declares
// the hooks it runs by extending HookEvents, so the kernel knows none of them.

export interface HookEvents {}

type Listener<Event> = (event: Event) => void | Promise<void>;

export interface Hooks {
  on<Name extends keyof HookEvents>(name: Name, listener: Listener<HookEvents[Name]>): void;
  run<Name extends keyof HookEvents>(name: Name, event: HookEvents[Name]): Promise<void>;
}

export function createHooks(): Hooks {
  const listeners = new Map<string, Listener<never>[]>();
  return {
    on(name, listener) {
      listeners.set(name, [...(listeners.get(name) ?? []), listener as Listener<never>]);
    },
    async run(name, event) {
      for (const listener of listeners.get(name) ?? []) await listener(event as never);
    },
  };
}
