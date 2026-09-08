import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { homebrewFormula, updateHomebrewCheckout, withHomebrewAuth } from "../../script/homebrew"

const key = "PRIVATE_DEPLOY_KEY_FIXTURE"
const token = "PRIVATE_TOKEN_FIXTURE"
const host = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEZpeHR1cmU="
const metadata = async () => Response.json({ ssh_keys: [host] })

test("SSH deploy key takes precedence, pins verified hosts, and removes its private files", async () => {
  let directory = ""
  const status = await withHomebrewAuth(
    { sshKey: key, token },
    async (auth) => {
      directory = auth.directory
      expect(auth.url).toBe("git@github.com:synthetic-sciences/homebrew-tap.git")
      expect(auth.env.GIT_SSH_COMMAND).toContain("StrictHostKeyChecking=yes")
      expect(auth.env.GIT_SSH_COMMAND).toContain("IdentitiesOnly=yes")
      expect(auth.env.GIT_SSH_COMMAND).toContain("IdentityAgent=none")
      expect(auth.env.GIT_SSH_COMMAND).toContain(path.join(directory, "known_hosts"))
      expect(auth.env.GIT_SSH_COMMAND).not.toContain(key)
      expect(auth.env.OPENSCIENCE_HOMEBREW_TOKEN).toBeUndefined()
      expect(auth.env.HOMEBREW_TAP_SSH_KEY).toBeUndefined()
      expect(auth.env.HOMEBREW_TAP_TOKEN).toBeUndefined()
      expect(auth.env.GH_TOKEN).toBeUndefined()
      expect(auth.env.NPM_TOKEN).toBeUndefined()
      expect(auth.env.SSH_AUTH_SOCK).toBeUndefined()
      expect(auth.env.GIT_CONFIG_COUNT).toBeUndefined()
      expect(await fs.readFile(path.join(directory, "identity"), "utf8")).toBe(key + "\n")
      if (process.platform !== "win32")
        expect((await fs.stat(path.join(directory, "identity"))).mode & 0o777).toBe(0o600)
      expect(await fs.readFile(path.join(directory, "known_hosts"), "utf8")).toBe(`github.com ${host}\n`)
      return "updated"
    },
    async (url, options) => {
      expect(url).toBe("https://api.github.com/meta")
      expect(options.redirect).toBe("error")
      expect(options.signal).toBeInstanceOf(AbortSignal)
      return metadata()
    },
  )
  expect(status).toBe("updated")
  expect(await fs.stat(directory).catch(() => undefined)).toBeUndefined()
})

test("failed authentication work cleans secrets and never relays a secret-bearing exception", async () => {
  let directory = ""
  const failed = withHomebrewAuth(
    { sshKey: key },
    async (auth) => {
      directory = auth.directory
      throw new Error(`Transport echoed ${key}`)
    },
    metadata,
  )
  await expect(failed).rejects.toThrow("authentication and Git output were withheld")
  await expect(failed).rejects.not.toThrow(key)
  expect(await fs.stat(directory).catch(() => undefined)).toBeUndefined()
  let dispatched = false
  await expect(
    withHomebrewAuth(
      { sshKey: key },
      async () => {
        dispatched = true
      },
      async () => Response.json({ ssh_keys: ["github.com injected\n*"] }),
    ),
  ).rejects.toThrow("Homebrew tap update failed")
  expect(dispatched).toBe(false)
  await expect(withHomebrewAuth({}, async () => {})).rejects.toThrow("credentials are missing")
})

test("tap Git receives neither unrelated release secrets nor ambient Git or SSH configuration", async () => {
  const names = [
    "GH_TOKEN",
    "NPM_TOKEN",
    "SSH_AUTH_SOCK",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
    "GIT_SSH_COMMAND",
  ]
  const before = names.map((name) => process.env[name])
  try {
    for (const name of names) process.env[name] = "UNRELATED_RELEASE_SECRET_OR_OVERRIDE"
    await withHomebrewAuth({ token }, async (auth) => {
      for (const name of names) expect(auth.env[name]).toBeUndefined()
      expect(auth.env.PATH).toBe(process.env.PATH)
      expect(auth.env.HOME).toBe(process.env.HOME)
    })
  } finally {
    names.forEach((name, index) => {
      if (before[index] === undefined) delete process.env[name]
      else process.env[name] = before[index]
    })
  }
})

test("legacy token uses child-only askpass instead of a URL or credential file", async () => {
  let directory = ""
  await withHomebrewAuth(
    { token },
    async (auth) => {
      directory = auth.directory
      expect(auth.url).toBe("https://github.com/synthetic-sciences/homebrew-tap.git")
      expect(auth.url).not.toContain(token)
      expect(auth.env.GIT_TERMINAL_PROMPT).toBe("0")
      expect(auth.env.OPENSCIENCE_HOMEBREW_TOKEN).toBe(token)
      expect(auth.env.HOMEBREW_TAP_TOKEN).toBeUndefined()
      const script = await fs.readFile(auth.env.GIT_ASKPASS!, "utf8")
      expect(script).not.toContain(token)
      expect(script).toContain("$OPENSCIENCE_HOMEBREW_TOKEN")
      for (const [prompt, expected] of [
        ["Username for https://github.com", "x-access-token"],
        ["Password for https://github.com", token],
      ]) {
        const proc = Bun.spawn(["sh", auth.env.GIT_ASKPASS!, prompt], {
          env: auth.env,
          stdout: "pipe",
          stderr: "ignore",
        })
        expect((await new Response(proc.stdout).text()).trim()).toBe(expected)
        expect(await proc.exited).toBe(0)
      }
    },
    async () => {
      throw new Error("PAT authentication must not fetch SSH host keys")
    },
  )
  expect(await fs.stat(directory).catch(() => undefined)).toBeUndefined()
  expect(process.env.OPENSCIENCE_HOMEBREW_TOKEN).not.toBe(token)
})

test("real local Git tap updates are idempotent and preserve a rejected push", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "homebrew-git-test-"))
  const remote = path.join(directory, "remote.git")
  const git = async (...args: string[]) => {
    const proc = Bun.spawn(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" })
    const output = await new Response(proc.stdout).text()
    const error = await new Response(proc.stderr).text()
    if ((await proc.exited) !== 0) throw new Error(error)
    return output.trim()
  }
  const update = (formula: string, version: string) =>
    withHomebrewAuth({ token }, (auth) => updateHomebrewCheckout({ ...auth, url: remote, formula, version }))
  try {
    await git("init", "--bare", "--initial-branch=main", remote)
    expect((await update("first formula\n", "2.0.81")).status).toBe("updated")
    const first = await git("--git-dir", remote, "rev-parse", "main")
    expect(await update("first formula\n", "2.0.81")).toEqual({ status: "unchanged", commit: first })
    expect(await git("--git-dir", remote, "rev-parse", "main")).toBe(first)
    expect(await git("--git-dir", remote, "rev-list", "--count", "main")).toBe("1")
    expect((await update("second formula\n", "2.0.82")).status).toBe("updated")
    expect(await git("--git-dir", remote, "show", "main:openscience.rb")).toBe("second formula")
    expect(await git("--git-dir", remote, "rev-list", "--count", "main")).toBe("2")
    const second = await git("--git-dir", remote, "rev-parse", "main")
    await fs.writeFile(path.join(remote, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o700 })
    await expect(update("rejected formula\n", "2.0.83")).rejects.toThrow("Homebrew tap update failed")
    expect(await git("--git-dir", remote, "rev-parse", "main")).toBe(second)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("formula generation requires stable versions and real digests", () => {
  const sha256 = {
    darwinArm64: "a".repeat(64),
    darwinX64: "b".repeat(64),
    linuxArm64: "c".repeat(64),
    linuxX64: "d".repeat(64),
  }
  const formula = homebrewFormula({ version: "2.0.81", sha256 })
  expect(formula).toContain('license "Apache-2.0"')
  expect(formula).toContain('shell_output("#{bin}/openscience --version")')
  expect(formula).not.toContain("GoReleaser")
  expect(() => homebrewFormula({ version: '2.0.81"; unsafe', sha256 })).toThrow("stable release version")
  expect(() => homebrewFormula({ version: "2.0.81", sha256: { ...sha256, linuxX64: "missing" } })).toThrow("digests")
})
