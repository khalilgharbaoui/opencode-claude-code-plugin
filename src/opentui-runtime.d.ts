// Minimal ambient types for the slice of opencode's TUI runtime that
// `src/tui.ts` uses. Kept local on purpose, like `bun-terminal.d.ts`: the
// package must not depend on `@opentui/*` or `solid-js`, because opencode
// resolves these bare specifiers in a plugin module to its OWN bundled copies
// (measured on 1.18.35, h #g234), and a second copy would be a second reactive
// runtime the host's slots know nothing about.
//
// A script file (no top-level import or export), so each `declare module`
// below declares the module rather than augmenting one that must exist.

/** An opentui renderable as the universal Solid renderer hands it out. */
interface OpentuiNode {
  readonly __opentuiNode?: never
}

declare module "@opentui/solid" {
  export function createElement(tag: string): OpentuiNode
  export function createTextNode(value: string): OpentuiNode
  export function insertNode(parent: OpentuiNode, node: OpentuiNode, anchor?: OpentuiNode): void
  export function insert<T>(parent: OpentuiNode, accessor: T | (() => T), marker?: unknown): OpentuiNode
  export function setProp<T>(node: OpentuiNode, name: string, value: T, prev?: T): T
  export function effect<T>(fn: (prev?: T) => T, init?: T): void
}

declare module "solid-js" {
  export type Accessor<T> = () => T
  export function createSignal<T>(value: T): [Accessor<T>, (next: T | ((prev: T) => T)) => T]
  export function createMemo<T>(fn: () => T): Accessor<T>
  export function onCleanup(fn: () => void): void
}

declare module "@opentui/core" {
  export class RGBA {
    r: number
    g: number
    b: number
    a: number
    static fromValues(r: number, g: number, b: number, a?: number): RGBA
  }
}
