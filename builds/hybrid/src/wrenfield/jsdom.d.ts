// jsdom ships no types and @types/jsdom isn't installed; test-aggregate.ts only needs the constructor.
declare module "jsdom" {
  export class JSDOM {
    constructor(html?: string, options?: Record<string, unknown>);
    readonly window: Window & typeof globalThis;
  }
}
