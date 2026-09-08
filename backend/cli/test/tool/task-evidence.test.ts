import { expect, test } from "bun:test"
import path from "node:path"
import { ArtifactStore } from "../../src/artifact/store"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { ArtifactTool } from "../../src/tool/artifact"
import { TaskEvidence } from "../../src/tool/task-evidence"
import type { MessageV2 } from "../../src/session/message-v2"
import { tmpdir } from "../fixture/fixture"

test("Task hands back only this turn's immutable child outputs, readable by the parent without scratch access", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const parent = await Session.create({})
      const child = await Session.create({ parentID: parent.id })
      const ctx = {
        sessionID: child.id,
        messageID: "msg_old",
        agent: "research",
        abort: new AbortController().signal,
        messages: [],
        metadata() {},
        async ask() {},
      }
      const source = path.join(await SessionFilesystem.workspace(child.id), "report.md")
      const content = "α".repeat(25_599) + "🧬" + "important final evidence".repeat(500)
      await Bun.write(source, "old report")
      const tool = await ArtifactTool.init()
      await tool.execute({ action: "save_file", path: source }, ctx)
      await Bun.write(source, content)
      await tool.execute({ action: "save_file", path: source }, { ...ctx, messageID: "msg_new" })
      await Bun.write(source, "later mutable scratch must not change handoff")
      const msg = (id: string): MessageV2.WithParts => ({
        info: {
          id,
          sessionID: child.id,
          role: "user",
          agent: "research",
          effort: "normal",
          model: { providerID: "fixture", modelID: "offline" },
          time: { created: 1 },
        },
        parts: [],
      })
      const evidence = await TaskEvidence.collect({
        projectID: Instance.project.id,
        sessionID: child.id,
        messages: [msg("msg_old"), msg("msg_new")],
        previous: new Set(["msg_old"]),
      })
      expect(evidence.artifacts).toHaveLength(1)
      const artifact = evidence.artifacts[0]
      expect(TaskEvidence.describe(evidence)).toContain(artifact.versionID)
      await expect(
        SessionFilesystem.authorize({ sessionID: parent.id, path: source, access: "read" }),
      ).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
      const params = { action: "read_file" as const, artifact_id: artifact.artifactID, version_id: artifact.versionID }
      const read = await tool.execute(params, { ...ctx, sessionID: parent.id })
      expect(read.metadata.sha256).toBe(artifact.sha256)
      expect(read.metadata.nextOffset).toBe(51_198)
      const rest = await tool.execute(
        { ...params, offset: read.metadata.nextOffset as number },
        { ...ctx, sessionID: parent.id },
      )
      expect(read.output.split("\n\n[More content:")[0] + rest.output).toBe(content)
      await expect(tool.execute({ ...params, version_id: "foreign-version" }, ctx)).rejects.toThrow("unavailable")
      await expect(tool.execute({ action: "read_file", artifact_id: artifact.artifactID }, ctx)).rejects.toThrow(
        "invalid arguments",
      )
      expect(await ArtifactStore.read("another-project", artifact.artifactID, artifact.versionID)).toBeUndefined()
      await Session.remove(child.id)
      await Session.remove(parent.id)
    },
  })
})
