import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { ComputeJobs } from "../../src/compute/jobs"
import { Instance } from "../../src/project/instance"
import { SessionFilesystem } from "../../src/session/filesystem"
import { KernelEnvironmentMutation } from "../../src/science/kernel/environment-mutation"
import { Config } from "../../src/config/config"
import { BashTool } from "../../src/tool/bash"
import { Sandbox } from "../../src/sandbox/sandbox"
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
            const code = `import ${name}, sys, os, importlib.util, json; assert importlib.util.find_spec("unapproved_import") is None; assert os.getenv("MODAL_TOKEN_ID") is None; open("receipt.json", "w").write(json.dumps({"binary": os.path.realpath(sys.executable), "value": ${name}.value}))`
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
              expect(result.reproducibility?.execution_environment).toMatchObject({
                target: "local",
                cwd: workspace,
                profile: "python",
                python: { role: "selected_default", executable: runtime.binary },
              })
              expect(await Bun.file(path.join(workspace, "receipt.json")).json()).toEqual({
                binary: await fs.realpath(runtime.binary!),
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

// Use two real installed interpreters. A symlink to the same Python verifies
// path selection but cannot catch a host-version receipt attached to a job
// launched with another interpreter. No interpreter is installed by the test.
function version(binary: string | null) {
  if (!binary) return
  const result = Bun.spawnSync([binary, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) return
  return result.stdout
    .toString()
    .trim()
    .match(/^Python (\d+\.\d+\.\d+\S*)$/)?.[1]
}

const host = Bun.which("python3") ?? Bun.which("python")
const hostVersion = version(host)
const alternate = ["python3.11", "python3.12", "python3.13", "python3.14"]
  .map((name) => Bun.which(name))
  .filter((binary): binary is string => !!binary)
  .map((binary) => ({ binary, version: version(binary) }))
  .find((item) => item.version && hostVersion && item.version !== hostVersion)

test.skipIf(process.platform === "win32" || !alternate)(
  "records the actual selected Python version when it differs from host python3",
  async () => {
    if (!alternate) throw new Error("This fixture requires two different installed Python versions")
    await using tmp = await tmpdir()
    const bin = path.join(tmp.path, ".venv", "bin")
    await fs.mkdir(bin, { recursive: true })
    await fs.symlink(alternate.binary, path.join(bin, "python"))
    // No python3 exists in this selected prefix. Merely prepending its
    // directory would still dispatch the unrelated host python3.
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await executionSession()
        const workspace = await SessionFilesystem.workspace(session.id)
        const options = { root: path.join(tmp.path, ".jobs"), projectDirectory: tmp.path, workspace }
        const job = await ComputeJobs.start(
          {
            name: "Selected interpreter identity",
            command: `python3 -c ${quote('import sys, json; print(json.dumps({"version":sys.version.split()[0],"executable":sys.executable}))')}`,
            target: { kind: "local" },
            sessionID: session.id,
          },
          options,
        )
        try {
          const result = await ComputeJobs.wait(job.id, { ...options, timeout: 5_000 })
          expect(result.status).toBe("succeeded")
          const actual = JSON.parse((await ComputeJobs.log(job.id, options)).trim())
          expect(actual.version).toBe(alternate.version)
          expect(actual.version).not.toBe(hostVersion)
          expect(result.reproducibility?.python).toBe(`Python ${actual.version}`)
          expect(result.reproducibility?.capture_scope).toBe("execution_host")
          expect(result.reproducibility?.execution_environment).toEqual({
            target: "local",
            cwd: workspace,
            profile: "python",
            python: { role: "selected_default", executable: path.join(bin, "python"), version: actual.version },
          })
          expect(await fs.realpath(actual.executable)).toBe(await fs.realpath(alternate.binary))
        } finally {
          const current = await ComputeJobs.get(job.id, options)
          if (current && ["pending", "running"].includes(current.status)) await ComputeJobs.cancel(job.id, options)
        }
      },
    })
  },
)

test.skipIf(process.platform !== "win32")("Windows login shell retains the selected native Python path", async () => {
  if (!host) throw new Error("Local runtime fixture needs Python")
  await using tmp = await tmpdir()
  const prefix = path.join(tmp.path, ".venv")
  // No pip or package installation: this creates only a disposable interpreter
  // launcher pointing to the already installed native Python runtime.
  const prepared = Bun.spawnSync([host, "-m", "venv", "--without-pip", prefix])
  expect(prepared.exitCode, prepared.stderr.toString()).toBe(0)
  const previous = await Config.trustedSandbox()
  await Config.setSandbox({ enabled: false })
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await executionSession()
        const workspace = await SessionFilesystem.workspace(session.id)
        const options = { root: path.join(tmp.path, ".jobs"), projectDirectory: tmp.path, workspace }
        const job = await ComputeJobs.start(
          {
            name: "Windows selected interpreter",
            command: `python -c ${quote('import sys,json; print(json.dumps({"executable":sys.executable,"version":sys.version.split()[0]}))')}`,
            target: { kind: "local" },
            sessionID: session.id,
          },
          options,
        )
        try {
          const result = await ComputeJobs.wait(job.id, { ...options, timeout: 5_000 })
          const log = await ComputeJobs.log(job.id, options)
          expect(result.status, log).toBe("succeeded")
          const actual = JSON.parse(log.trim())
          expect(await fs.realpath(actual.executable)).toBe(
            await fs.realpath(path.join(prefix, "Scripts", "python.exe")),
          )
          expect(result.reproducibility?.execution_environment?.python).toEqual({
            role: "selected_default",
            executable: path.join(prefix, "Scripts", "python.exe"),
            version: actual.version,
          })
        } finally {
          const current = await ComputeJobs.get(job.id, options)
          if (current && ["pending", "running"].includes(current.status)) await ComputeJobs.cancel(job.id, options)
        }
      },
    })
  } finally {
    await Config.setSandbox(previous)
  }
})

for (const enabled of [false, true]) {
  test.skipIf(process.platform === "win32" || (enabled && !Sandbox.available()))(
    `Bash and compute preserve a real venv prefix (${enabled ? "sandboxed" : "unsandboxed"})`,
    async () => {
      if (!host) throw new Error("Local runtime fixture needs Python")
      await using tmp = await tmpdir()
      const prefix = path.join(tmp.path, ".venv")
      const prepared = Bun.spawnSync([host, "-m", "venv", "--without-pip", prefix])
      expect(prepared.exitCode, prepared.stderr.toString()).toBe(0)
      await fs.rm(path.join(prefix, "bin", "python3"), { force: true })
      const previous = await Config.trustedSandbox()
      await Config.setSandbox({ enabled, onUnavailable: "error" })
      try {
        await Instance.provide({
          directory: tmp.path,
          fn: async () => {
            const session = await executionSession()
            const workspace = await SessionFilesystem.workspace(session.id)
            const options = { root: path.join(tmp.path, ".jobs"), projectDirectory: tmp.path, workspace }
            const command = `python3 -c ${quote('import sys,json; print(json.dumps({"prefix":sys.prefix,"executable":sys.executable}))')}`
            const shell = await (
              await BashTool.init()
            ).execute(
              { command, description: "Check selected venv" },
              {
                sessionID: session.id,
                messageID: "msg_venv",
                callID: "call_venv",
                agent: "research",
                abort: AbortSignal.any([]),
                messages: [],
                metadata() {},
                async ask() {},
              },
            )
            expect(shell.metadata.exit, shell.output).toBe(0)
            expect(JSON.parse(shell.output.trim())).toEqual({ prefix, executable: path.join(prefix, "bin", "python") })
            const job = await ComputeJobs.start(
              { name: "Selected venv prefix", command, target: { kind: "local" }, sessionID: session.id },
              options,
            )
            try {
              const result = await ComputeJobs.wait(job.id, { ...options, timeout: 5_000 })
              const log = await ComputeJobs.log(job.id, options)
              expect(result.status, log).toBe("succeeded")
              expect(JSON.parse(log.trim())).toEqual({ prefix, executable: path.join(prefix, "bin", "python") })
              expect(result.reproducibility?.execution_environment?.python?.executable).toBe(
                path.join(prefix, "bin", "python"),
              )
            } finally {
              const current = await ComputeJobs.get(job.id, options)
              if (current && ["pending", "running"].includes(current.status)) await ComputeJobs.cancel(job.id, options)
            }
          },
        })
      } finally {
        await Config.setSandbox(previous)
      }
    },
  )
}
