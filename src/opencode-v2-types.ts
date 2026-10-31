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

/**
 * `@opencode/plugin` 2.2.2 `SessionRetry`, the `session.hook("retry")` event:
 * opencode asks before it runs a failed turn again (h #g277).
 */
export interface V2SessionRetryEvent {
  readonly sessionID: string
  readonly model: { readonly id: string; readonly providerID: string }
  readonly error: { readonly type?: string; readonly message?: string }
  readonly attempt: number
  decision: { retry: false } | { retry: true; delay: number }
}

/** One way to connect an integration (`IntegrationMethod`); only `type` is always there. */
export interface V2IntegrationMethod {
  readonly type: string
  readonly id?: string
  readonly label?: string
}

/** `@opencode/plugin` 2.2.2 `IntegrationEditor`, the calls we make. */
export interface V2IntegrationEditor {
  get(id: string): { id: string; name: string } | undefined
  update(id: string, update: (integration: { id: string; name: string }) => void): void
  readonly method: {
    list(integrationID: string): readonly V2IntegrationMethod[]
    update(input: {
      integrationID: string
      method: { id: string; type: "external"; label: string }
    }): void
    remove(integrationID: string, method: V2IntegrationMethod): void
  }
}

/** `@opencode/client` `ConnectionInfo`, passed back to opencode untouched. */
export interface V2ConnectionInfo {
  readonly type: string
  readonly id?: string
  readonly label?: string
}

/** `@opencode/schema/connection` `Connection.Status`. */
export interface V2ConnectionStatus {
  status: "needs_auth"
  message: string
  url?: string
}

/** `@opencode/plugin` 2.2.2 `IntegrationDomain`, the slice `/connect` needs. */
export interface V2IntegrationDomain {
  transform(callback: (editor: V2IntegrationEditor) => void): Promise<V2Registration>
  readonly connection: {
    active(integrationID: string): Promise<V2ConnectionInfo | undefined>
    status(input: {
      integrationID: string
      connection: V2ConnectionInfo
      status: V2ConnectionStatus | undefined
    }): Promise<void>
  }
}

/** `@opencode/schema/prompt-input` `Prompt`: we only rewrite `text`. */
export type V2Prompt = { text?: string } & Record<string, unknown>

export type V2Delivery = "steer" | "queue"

export interface V2CommandInvocation {
  readonly sessionID: string
  readonly prompt: V2Prompt
  readonly delivery: V2Delivery
}

export interface V2CommandDefinition {
  readonly name: string
  readonly description?: string
  readonly execute: (input: V2CommandInvocation) => Promise<void>
}

/**
 * A bus event. Acted on: `session.deleted`, `session.execution.started` /
 * `succeeded` / `failed` / `interrupted` (with `reason`, measured on 2.0.31,
 * h #g253), and the never-emitted-there `session.status` / `session.idle`.
 */
export interface V2Event {
  readonly type?: string
  readonly data?: { readonly sessionID?: string } & Record<string, unknown>
}

/**
 * `ctx.rpc.register`'s result (`@opencode/plugin` 2.0.31 `RpcRegistration`):
 * a registration whose events travel on the bus as `rpc.<id>.<event>`.
 */
export interface V2RpcRegistration extends V2Registration {
  readonly events: {
    emit(name: string, data: Record<string, unknown>): Promise<void>
  }
}

export interface V2Context {
  readonly app: { readonly version: string }
  readonly location: { readonly directory: string }
  readonly options: Record<string, unknown>
  readonly provider: {
    transform(callback: (editor: V2ProviderEditor) => void): Promise<V2Registration>
    /** Re-runs the transforms. In `@opencode/plugin` 2.2.5; optional because older hosts may lack it. */
    reload?(): Promise<void>
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
    hook(
      name: "retry",
      callback: (event: V2SessionRetryEvent) => Promise<void> | void,
      options?: V2ModelHookOptions,
    ): Promise<V2Registration>
    prompt?(input: V2Prompt & { sessionID: string; delivery?: V2Delivery }): Promise<unknown>
  }
  readonly command?: {
    transform(
      callback: (editor: { add(definition: V2CommandDefinition): void }) => void,
    ): Promise<V2Registration>
  }
  readonly event?: {
    subscribe(options?: { signal?: AbortSignal }): AsyncIterable<V2Event>
  }
  /** `/connect`'s entry for each provider (h #g277). Optional: early 2.0 releases lack parts of it. */
  readonly integration?: V2IntegrationDomain
  /**
   * Absent before 2.0.31's measured shape: the definition is plain JSON
   * Schema, which `Rpc.PortableDefinition` accepts, and the handlers object is
   * empty because the definition declares no methods.
   */
  readonly rpc?: {
    register(definition: unknown, handlers: Record<string, never>): Promise<V2RpcRegistration>
  }
  readonly skill?: {
    transform(
      callback: (editor: {
        get(id: string): unknown
        add(skill: { id: string; name: string; description?: string; path: string; content: string }): void
      }) => void,
    ): Promise<V2Registration>
  }
}

/** What `setup` may return: a cleanup run when opencode unloads the plugin. */
export type V2Cleanup = () => void | Promise<void>
