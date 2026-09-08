import type { SessionHarness } from "./harness"

export namespace Toolset {
  /** The repair-only tool is executable internally, but is never advertised. */
  export function active(tools: Record<string, unknown>) {
    return Object.keys(tools).filter((name) => name !== "invalid")
  }

  export function previous(
    records: SessionHarness.Entry[],
    input: { messageID: string; profile: string; mode: string },
  ) {
    // Internal compaction/title requests must not replace the active agent's
    // baseline. Retried requests compare against the same preceding assistant.
    const entry = records.findLast(
      (item) => item.messageID !== input.messageID && item.profile === input.profile && item.mode === input.mode,
    )
    return entry?.tools.map((item) => item.name).filter((name) => name !== "invalid")
  }

  function list(names: string[]) {
    const shown: string[] = []
    for (const name of names) {
      const value = JSON.stringify(name)
      if (shown.length === 20 || shown.join(", ").length + value.length > 384) break
      shown.push(value)
    }
    return `[${shown.join(", ")}]${shown.length < names.length ? ` (${names.length - shown.length} more)` : ""}`
  }

  export function notice(current: string[], previous?: string[]) {
    if (!previous) return
    const before = new Set(previous)
    const after = new Set(current)
    const added = [...after].filter((name) => !before.has(name)).toSorted()
    const removed = [...before].filter((name) => !after.has(name)).toSorted()
    if (!added.length && !removed.length) return
    return [
      "Tool availability changed for this request.",
      ...(added.length ? [`Added tools: ${list(added)}.`] : []),
      ...(removed.length ? [`Removed tools: ${list(removed)}.`] : []),
      "Use only the currently advertised tool definitions. This changes availability, not filesystem or execution authority.",
    ].join("\n")
  }
}
