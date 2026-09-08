import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Bus } from "../../src/bus"
import { LSP } from "../../src/lsp"
import { Instance } from "../../src/project/instance"
import { tmpdir, trustProject } from "../fixture/fixture"

test("an exited LSP stays visible as an error and retries only after explicit reset", async () => {
  await using fixture = await tmpdir({
    config: {
      lsp: { receipt: { command: [process.execPath, "server.cjs"], extensions: [".lsp-status"] } },
    },
  })
  const source = path.join(fixture.path, "probe.lsp-status")
  const attempts = path.join(fixture.path, "attempts")
  const allow = path.join(fixture.path, "allow")
  const fake = await fs.readFile(path.join(import.meta.dir, "../fixture/lsp/fake-lsp-server.js"), "utf8")
  await fs.writeFile(source, "example")
  await fs.writeFile(
    path.join(fixture.path, "server.cjs"),
    `const fs = require("node:fs"); fs.appendFileSync("attempts", "attempt\\n");
if (!fs.existsSync("allow")) { console.error("PRIVATE_SERVER_FAILURE"); process.exit(1); }
${fake}`,
  )
  await Instance.provide({
    directory: fixture.path,
    fn: async () => {
      await trustProject()
      const changes: unknown[] = []
      const unsubscribe = Bus.subscribe(LSP.Event.Updated, (event) => {
        changes.push(event)
      })
      try {
        await LSP.touchFile(source)
        expect(await LSP.status()).toEqual([{ id: "receipt", name: "receipt", root: "", status: "error" }])
        expect(changes.length).toBeGreaterThan(0)
        expect(await fs.readFile(attempts, "utf8")).toBe("attempt\n")
        await LSP.touchFile(source)
        await LSP.status()
        expect(await fs.readFile(attempts, "utf8")).toBe("attempt\n")
        await fs.writeFile(allow, "allow")
        await LSP.dispose()
        expect(await LSP.status()).toEqual([])
        await LSP.touchFile(source)
        expect(await LSP.status()).toEqual([{ id: "receipt", name: "receipt", root: "", status: "connected" }])
        expect(await fs.readFile(attempts, "utf8")).toBe("attempt\nattempt\n")
      } finally {
        unsubscribe()
        await LSP.dispose()
        await Instance.dispose()
      }
    },
  })
})

test("resetting an initializing LSP does not resurrect an error from the old generation", async () => {
  await using fixture = await tmpdir({
    config: { lsp: { pending: { command: [process.execPath, "pending.cjs"], extensions: [".lsp-pending"] } } },
  })
  const source = path.join(fixture.path, "probe.lsp-pending")
  const ready = path.join(fixture.path, "ready")
  await fs.writeFile(source, "example")
  await fs.writeFile(
    path.join(fixture.path, "pending.cjs"),
    `require("node:fs").writeFileSync("ready", "ready"); process.stdin.resume();`,
  )
  await Instance.provide({
    directory: fixture.path,
    fn: async () => {
      await trustProject()
      const pending = LSP.touchFile(source)
      try {
        for (let attempt = 0; attempt < 200 && !(await Bun.file(ready).exists()); attempt++) await Bun.sleep(10)
        expect(await Bun.file(ready).exists()).toBe(true)
        await LSP.dispose()
        await pending
        expect(await LSP.status()).toEqual([])
      } finally {
        await LSP.dispose()
        await pending
        await Instance.dispose()
      }
    },
  })
})
