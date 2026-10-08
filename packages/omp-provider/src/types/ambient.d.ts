// Minimal ambient declarations so `tsc` does not need OMP installed.
// At build time these specifiers stay external and OMP's extension loader
// resolves them to its in-process modules.
declare module "@oh-my-pi/pi-ai" {
  export function createAssistantMessageEventStream(): unknown;
}
