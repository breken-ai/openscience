import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { ComputeJobs } from "../../src/compute/jobs"
import { Instance } from "../../src/project/instance"
import { SessionFilesystem } from "../../src/session/filesystem"
import { KernelEnvironmentMutation } from "../../src/science/kernel/environment-mutation"
import { executionSession, tmpdir } from "../fixture/fixture"

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

test.skipIf(process.platform === "win32")(
  "a local compute job uses the canonical Python and package overlay after login-shell initialization",
  async () => {
    await using tmp = await tmpdir()
    await using ambient = await tmpdir()
    // A real project interpreter path must win over the host PATH, including
    // shells whose login startup resets PATH. No installation is required.
    const binary = Bun.which("python3") ?? Bun.which("python")
    if (!binary) throw new Error("Local runtime fixture needs Python")
    const bin = path.join(tmp.path, ".venv", "bin")
    await fs.mkdir(bin, { recursive: true })
    await fs.symlink(binary, path.join(bin, "python"))
    await fs.symlink(binary, path.join(bin, "python3"))
    const previous = { PYTHONPATH: process.env.PYTHONPATH, MODAL_TOKEN_ID: process.env.MODAL_TOKEN_ID }
    process.env.PYTHONPATH = ambient.path
    process.env.MODAL_TOKEN_ID = "ak-isolated-local-compute-test"
    try {
      await Bun.write(path.join(ambient.path, "unapproved_import.py"), "value = 'unapproved'\n")
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await executionSession()
          const workspace = await SessionFilesystem.workspace(session.id)
          const runtime = await KernelEnvironmentMutation.pythonSubprocessRuntime()
          const name = `approved_${crypto.randomUUID().replaceAll("-", "")}`
          const module = path.join(runtime.env.PYTHONPATH, `${name}.py`)
          await Bun.write(module, "value = 'canonical-package'\n")
          const options = { root: path.join(tmp.path, ".jobs"), projectDirectory: tmp.path, workspace }
          try {
            const code = `import ${name}, sys, os, importlib.util, json, shutil; assert importlib.util.find_spec("unapproved_import") is None; assert os.getenv("MODAL_TOKEN_ID") is None; open("receipt.json", "w").write(json.dumps({"binary": os.path.realpath(sys.executable), "selected": os.path.dirname(shutil.which("python3")), "value": ${name}.value}))`
            const job = await ComputeJobs.start(
              {
                name: "Canonical runtime check",
                command: `python3 -c ${quote(code)}`,
                target: { kind: "local" },
                sessionID: session.id,
              },
              options,
            )
            try {
              const result = await ComputeJobs.wait(job.id, { ...options, timeout: 5_000 })
              expect(result.status).toBe("succeeded")
              expect(await Bun.file(path.join(workspace, "receipt.json")).json()).toEqual({
                binary: await fs.realpath(runtime.binary!),
                selected: bin,
                value: "canonical-package",
              })
            } finally {
              const current = await ComputeJobs.get(job.id, options)
              if (current && ["pending", "running"].includes(current.status)) await ComputeJobs.cancel(job.id, options)
            }
          } finally {
            await fs.rm(module, { force: true })
          }
        },
      })
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  },
)
