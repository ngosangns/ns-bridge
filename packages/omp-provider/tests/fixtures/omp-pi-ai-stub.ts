// Stand-in for OMP's in-process `@oh-my-pi/pi-ai` when loading dist/index.js under vitest.
export function createAssistantMessageEventStream() {
  const events: unknown[] = [];
  return {
    events,
    push(event: unknown) {
      events.push(event);
    },
    end() {},
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
  };
}
