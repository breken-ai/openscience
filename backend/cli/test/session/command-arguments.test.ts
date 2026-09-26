import { afterEach, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { tmpdir, trustProject } from "../fixture/fixture"

const spies: { mockRestore(): void }[] = []
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
})

async function templateFor(template: string, args: string) {
  await using tmp = await tmpdir({
    git: true,
    init: async (directory) => {
      const root = path.join(directory, ".openscience", "command")
      await fs.mkdir(root, { recursive: true })
      await Bun.write(path.join(root, "explain.md"), ["---", "description: Explain", "---", template].join("\n"))
    },
  })
  return await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const session = await Session.create({})
      // The contract under test ends once the command's parts are built; stop
      // there instead of calling a model.
      spies.push(spyOn(Provider, "getModel").mockResolvedValue({} as never))
      const trigger = Plugin.trigger
      const captured: { text?: string } = {}
      spies.push(
        spyOn(Plugin, "trigger").mockImplementation((async (name: string, input: unknown, output: unknown) => {
          if (name !== "command.execute.before") return trigger(name as never, input as never, output as never)
          const part = (output as { parts: { type: string; text?: string }[] }).parts.find((p) => p.type === "text")
          captured.text = part?.text
          throw new Error("stop after command parts")
        }) as typeof Plugin.trigger),
      )
      await SessionPrompt.command({
        sessionID: session.id,
        command: "explain",
        arguments: args,
        model: "fixture/model",
      }).catch(() => undefined)
      return captured.text
    },
  })
}

test("$ARGUMENTS inserts the arguments verbatim, dollar signs included", async () => {
  const args = "$$\\alpha + \\beta$$ with $& and $' kept"
  expect(await templateFor("Explain: $ARGUMENTS", args)).toBe(`Explain: ${args}`)
})

test("numbered placeholders already insert dollar signs verbatim", async () => {
  expect(await templateFor("Explain: $1", "$$x$$")).toBe("Explain: $$x$$")
})
