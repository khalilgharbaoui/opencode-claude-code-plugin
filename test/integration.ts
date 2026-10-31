/**
 * Integration test for opencode-claude-code plugin.
 * Tests the plugin against the real Claude CLI.
 */
import "./isolate.js"
import { createClaudeCode } from "../src/index.js"

const provider = createClaudeCode({
  skipPermissions: true,
})

async function testStreamWithModel(modelId: string) {
  console.log(`\n=== Test: doStream (${modelId}) ===`)
  const model = provider.languageModel(modelId)

  console.log("modelId:", model.modelId)
  console.log("provider:", model.provider)

  const { stream } = await model.doStream({
    inputFormat: "messages",
    mode: { type: "regular" },
    prompt: [
      {
        role: "user",
        content: [{ type: "text", text: "Say exactly: hello from " + modelId }],
      },
    ],
  } as any)

  const reader = stream.getReader()
  let fullText = ""
  const eventTypes = new Set<string>()

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    eventTypes.add(value.type)

    if (value.type === "text-delta") {
      fullText += (value as any).delta
      process.stdout.write((value as any).delta)
    } else if (value.type === "finish") {
      const fin = value as any
      console.log("\n\nFinish reason:", fin.finishReason)
      console.log("Usage:", JSON.stringify(fin.usage))
    }
  }

  console.log("Full text:", JSON.stringify(fullText))

  const pass =
    eventTypes.has("stream-start") &&
    eventTypes.has("text-start") &&
    eventTypes.has("text-delta") &&
    eventTypes.has("text-end") &&
    eventTypes.has("finish") &&
    fullText.length > 0

  console.log("Result:", pass ? "PASS" : "FAIL")
  if (!pass) {
    console.error("Event types:", [...eventTypes].join(", "))
    process.exit(1)
  }
}

async function testGenerateWithModel(modelId: string) {
  console.log(`\n=== Test: doGenerate (${modelId}) ===`)
  const model = provider.languageModel(modelId)

  const result = await model.doGenerate({
    inputFormat: "messages",
    mode: { type: "regular" },
    prompt: [
      {
        role: "user",
        content: [{ type: "text", text: "Say exactly: test passed" }],
      },
    ],
  } as any)

  console.log("Finish reason:", result.finishReason)
  console.log("Usage:", JSON.stringify(result.usage))

  const textContent = result.content.find((c) => c.type === "text")
  const text = textContent && "text" in textContent ? textContent.text : ""
  console.log("Text:", JSON.stringify(text))

  const pass = text.length > 0 && !!result.finishReason && !!result.usage
  console.log("Result:", pass ? "PASS" : "FAIL")
  if (!pass) process.exit(1)
}

async function main() {
  try {
    // Test with haiku (fastest, cheapest)
    await testStreamWithModel("haiku")
    await testGenerateWithModel("haiku")

    // Test with sonnet
    await testStreamWithModel("sonnet")

    console.log("\n=== ALL TESTS PASSED ===")
    process.exit(0)
  } catch (err) {
    console.error("\nTest error:", err)
    process.exit(1)
  }
}

main()
