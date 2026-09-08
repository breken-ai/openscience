import { ArtifactStore } from "@/artifact/store"
import type { MessageV2 } from "@/session/message-v2"
import { observableToolStatus } from "@/session/tool-outcome"

/** Evidence is derived from persisted execution records, never parsed out of
 * the worker's prose. Exit zero is an outer-process result, not test success. */
export namespace TaskEvidence {
  export async function collect(input: {
    projectID: string
    sessionID: string
    messages: MessageV2.WithParts[]
    previous: Set<string>
  }) {
    const current = input.messages.filter((message) => !input.previous.has(message.info.id))
    const ids = new Set(current.map((message) => message.info.id))
    const artifacts = (await ArtifactStore.listSessionVersions(input.projectID, input.sessionID))
      .filter((version) => version.messageID && ids.has(version.messageID))
      .map((version) => ({
        artifactID: version.artifactID,
        versionID: version.id,
        filename: version.filename,
        size: version.size,
        sha256: version.sha256,
        captureQuality: version.captureQuality,
      }))
    const commands = current
      .filter((message) => message.info.role === "assistant")
      .flatMap((message) =>
        message.parts.flatMap((part) => {
          if (part.type !== "tool" || part.tool !== "bash") return []
          const metadata = part.state.status === "completed" ? part.state.metadata : undefined
          return [
            {
              messageID: part.messageID,
              partID: part.id,
              callID: part.callID,
              status: observableToolStatus(part),
              exit: typeof metadata?.exit === "number" ? metadata.exit : null,
              ...(typeof metadata?.provenanceID === "string" && { provenanceID: metadata.provenanceID }),
            },
          ]
        }),
      )
    return { artifacts, commands }
  }

  export function describe(evidence: Awaited<ReturnType<typeof collect>>) {
    const lines = evidence.artifacts.map(
      (artifact) =>
        `- ${JSON.stringify(artifact.filename)}: artifact_id=${artifact.artifactID}, version_id=${artifact.versionID}, bytes=${artifact.size}, sha256=${artifact.sha256}`,
    )
    return [
      ...(lines.length
        ? ["Saved outputs (immutable versions; use artifact read_file with these exact IDs):", ...lines]
        : []),
      ...(evidence.commands.length
        ? [
            `Execution receipts: ${evidence.commands.length} shell calls, ${evidence.commands.filter((item) => item.exit === 0).length} with outer exit 0, ${evidence.commands.filter((item) => item.status === "error").length} failed. Full receipts remain in the child trace. An outer exit 0 alone does not verify nested tests or scientific conclusions.`,
          ]
        : []),
    ].join("\n")
  }
}
