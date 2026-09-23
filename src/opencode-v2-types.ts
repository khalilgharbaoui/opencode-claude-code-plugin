/**
 * Hand-written structural mirror of the slice of opencode 2.x's plugin API
 * this package touches. Same approach as `opencode-types.ts` for V1: no
 * runtime or type dependency on `@opencode/plugin`, whose promise API pulls in
 * an Effect release candidate we have no other use for.
 *
 * Read off the shipped `.d.ts` of `@opencode/plugin@2.0.11`, `@opencode/schema`
 * and `@opencode/client` at the same version, not off the website, whose
 * provider docs describe a metadata-only surface and omit the `aisdk` domain
 * entirely. Every field here is one we read or write; everything else is left
 * out on purpose so drift in an unused corner cannot break the build.
 */

import type { LanguageModelV3 } from "@ai-sdk/provider"

export interface V2Registration {
  readonly dispose: () => Promise<void>
}

/** `@opencode/schema/provider` `Provider.Info`, the fields we set. */
export interface V2ProviderInfo {
  id: string
  name: string
  activation: "auto" | "enabled" | "disabled"
  package: string
  settings?: Record<string, unknown>
  headers?: Record<string, string>
  body?: Record<string, unknown>
}

export interface V2ModelVariant {
  id: string
  settings?: Record<string, unknown>
  headers?: Record<string, string>
  body?: Record<string, unknown>
}

export interface V2ModelCost {
  input: number
  output: number
  cache: { read: number; write: number }
}

/** `@opencode/schema/model` `Model.Info`, every required field plus the optional ones we fill. */
export interface V2ModelInfo {
  id: string
  modelID: string
  providerID: string
  name: string
  family?: string
  capabilities: { tools: boolean; input: string[]; output: string[] }
  variants: V2ModelVariant[]
  time: { released: number }
  cost: V2ModelCost[]
  status: "alpha" | "beta" | "deprecated" | "active"
  enabled: boolean
  limit: { context: number; input?: number; output: number }
  settings?: Record<string, unknown>
  headers?: Record<string, string>
  package?: string
}

export interface V2ProviderRecord {
  readonly provider: V2ProviderInfo
  readonly models: ReadonlyMap<string, V2ModelInfo>
}

export interface V2ProviderEditor {
  list(): readonly V2ProviderRecord[]
  get(providerID: string): V2ProviderRecord | undefined
  add(input: { info: V2ProviderInfo; models: readonly V2ModelInfo[] }): void
  update(providerID: string, update: (provider: V2ProviderInfo) => void): void
  remove(providerID: string): void
  readonly models: {
    set(providerID: string, models: readonly V2ModelInfo[]): void
  }
}

export interface V2AISDKSdkEvent {
  readonly model: V2ModelInfo
  readonly package: string
  readonly options: Record<string, unknown>
  sdk?: unknown
}

export interface V2AISDKLanguageEvent {
  readonly model: V2ModelInfo
  readonly sdk: unknown
  readonly options: Record<string, unknown>
  language?: LanguageModelV3
}

export type V2RequestKind = "primary" | "compaction" | "title" | "generate"

export interface V2ModelRequestEvent {
  readonly sessionID: string
  readonly agent: string
  readonly model: { id: string; providerID: string; variant?: string }
  readonly kind: V2RequestKind
  baseURL?: string
  headers: Record<string, string>
}

export interface V2ModelHookOptions {
  readonly providerID?: string
}

export interface V2Context {
  readonly app: { readonly version: string }
  readonly location: { readonly directory: string }
  readonly options: Record<string, unknown>
  readonly provider: {
    transform(callback: (editor: V2ProviderEditor) => void): Promise<V2Registration>
  }
  readonly aisdk: {
    hook(
      name: "sdk",
      callback: (event: V2AISDKSdkEvent) => Promise<void> | void,
      options?: V2ModelHookOptions,
    ): Promise<V2Registration>
    hook(
      name: "language",
      callback: (event: V2AISDKLanguageEvent) => Promise<void> | void,
      options?: V2ModelHookOptions,
    ): Promise<V2Registration>
  }
  readonly session: {
    hook(
      name: "model.request",
      callback: (event: V2ModelRequestEvent) => Promise<void> | void,
      options?: V2ModelHookOptions,
    ): Promise<V2Registration>
  }
}

/** What `setup` may return: a cleanup run when opencode unloads the plugin. */
export type V2Cleanup = () => void | Promise<void>
