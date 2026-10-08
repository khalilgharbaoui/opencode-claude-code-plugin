import { defineConfig } from "tsup"

export default defineConfig({
  // `tui` is the TUI half (`exports["./tui"]`): opencode loads it from a
  // different config list and resolves its `@opentui/*` and `solid-js`
  // imports to its own bundled runtime, so they must stay bare imports.
  entry: ["src/index.ts", "src/tui.ts"],
  format: ["esm"],
  dts: { entry: "src/index.ts" },
  external: ["@opentui/core", "@opentui/solid", "solid-js"],
  splitting: false,
  sourcemap: true,
  clean: true,
  target: "es2022",
})
