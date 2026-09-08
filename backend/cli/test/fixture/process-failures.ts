import { spyOn } from "bun:test"
import * as childProcess from "node:child_process"

/** Keep real launch/ownership behavior, but retain bounded fixture stderr when
 * a platform fails before the payload can write its readiness marker. */
export function processFailures() {
  const spawn = childProcess.spawn
  const entries: Array<{
    command: string
    pid?: number
    code?: number | null
    signal?: string | null
    stderr: string
  }> = []
  const trace = spyOn(childProcess, "spawn").mockImplementation(((
    command: string,
    input?: readonly string[] | childProcess.SpawnOptions,
    settings?: childProcess.SpawnOptions,
  ) => {
    const argv = Array.isArray(input) ? input : []
    const options = input && !Array.isArray(input) ? (input as childProcess.SpawnOptions) : settings
    const child = spawn(command, argv, {
      ...options,
      stdio: options?.stdio === "ignore" ? ["ignore", "ignore", "pipe"] : options?.stdio,
    })
    const entry: (typeof entries)[number] = { command, pid: child.pid, stderr: "" }
    entries.push(entry)
    child.stderr?.on("data", (chunk: Buffer) => {
      entry.stderr = (entry.stderr + chunk.toString()).slice(-4096)
    })
    child.on("error", (error) => {
      entry.stderr = (entry.stderr + error.message).slice(-4096)
    })
    child.on("close", (code, signal) => {
      entry.code = code
      entry.signal = signal
    })
    return child
  }) as typeof spawn)
  return {
    report() {
      console.error("Fixture subprocess failures", entries.slice(-8))
    },
    [Symbol.dispose]() {
      trace.mockRestore()
    },
  }
}
