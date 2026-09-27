import Foundation
import XCTest
@testable import KodaGUI

final class RemoteClientTests: XCTestCase {
    @MainActor
    func testLateFramesFromPreviousThreadDoNotChangeCurrentConversation() {
        let model = RemoteModel()
        model.selectThread("first")
        model.handle(RemoteSubscriptionFrame(
            kind: "update",
            event: RemoteUpdate(sequence: 1, turnId: "turn-first",
                                type: "assistant.delta", text: "first", code: nil),
            nextAfterSequence: nil
        ), for: "first")
        XCTAssertEqual(model.entries.map(\.text), ["first"])

        model.selectThread("second")
        model.handle(RemoteSubscriptionFrame(
            kind: "update",
            event: RemoteUpdate(sequence: 100, turnId: "turn-first",
                                type: "assistant.delta", text: "late", code: nil),
            nextAfterSequence: nil
        ), for: "first")
        model.handle(RemoteSubscriptionFrame(
            kind: "cursor", event: nil, nextAfterSequence: 100
        ), for: "first")
        model.handle(RemoteSubscriptionFrame(
            kind: "update",
            event: RemoteUpdate(sequence: 1, turnId: "turn-second",
                                type: "assistant.delta", text: "second", code: nil),
            nextAfterSequence: nil
        ), for: "second")
        XCTAssertEqual(model.entries.map(\.text), ["second"])
        model.activeTurns["second"] = "turn-second"
        model.handle(RemoteSubscriptionFrame(
            kind: "update",
            event: RemoteUpdate(sequence: 2, turnId: "turn-second",
                                type: "turn.cancelled", text: nil, code: nil),
            nextAfterSequence: nil
        ), for: "second")
        XCTAssertNil(model.activeTurns["second"])
    }

    func testRealRemoteServerCertificateAuthorizationTurnAndReplay() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("koda-remote-client-\(UUID().uuidString)")
        let workspace = root.appendingPathComponent("workspace")
        try FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let certificate = root.appendingPathComponent("cert.pem")
        let key = root.appendingPathComponent("key.pem")
        try run("openssl", [
            "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", key.path, "-out", certificate.path,
            "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
            "-addext", "extendedKeyUsage=serverAuth", "-days", "1",
        ])
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o600], ofItemAtPath: key.path
        )

        let repository = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
        let fixture = repository.appendingPathComponent(
            "packages/testkit/fixtures/remote-client-server.mjs"
        )
        let server = Process()
        let output = Pipe()
        let errors = Pipe()
        let control = Pipe()
        server.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        server.arguments = ["node", fixture.path, root.path, workspace.path,
                            certificate.path, key.path]
        server.standardOutput = output
        server.standardError = errors
        server.standardInput = control
        try server.run()
        defer { server.terminate(); server.waitUntilExit() }
        var line = ""
        while let byte = try output.fileHandleForReading.read(upToCount: 1), !byte.isEmpty {
            let character = String(decoding: byte, as: UTF8.self)
            if character == "\n" { break }
            line += character
        }
        guard let setup = try? JSONDecoder().decode(FixtureSetup.self, from: Data(line.utf8)) else {
            XCTFail("Real remote server fixture did not start: \(String(decoding: errors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self))")
            return
        }

        let cancelledModel = await RemoteModel()
        await cancelledModel.connect(RemoteSettings(
            origin: setup.origin, certificateSha256: setup.fingerprint, token: setup.token
        ), save: false)
        await cancelledModel.cancelPendingConnection()
        try await Task.sleep(nanoseconds: 200_000_000)
        let cancelledState = await (cancelledModel.connected, cancelledModel.connecting)
        XCTAssertFalse(cancelledState.0)
        XCTAssertFalse(cancelledState.1)

        let wrong = try RemoteClient(settings: RemoteSettings(
            origin: setup.origin, certificateSha256: String(repeating: "0", count: 64),
            token: setup.token
        ))
        do {
            _ = try await wrong.listWorkspaces()
            XCTFail("A wrong certificate pin must fail")
        } catch { }
        wrong.close()

        let workspaceOnly = try RemoteClient(settings: RemoteSettings(
            origin: setup.origin, certificateSha256: setup.fingerprint,
            token: setup.workspaceOnlyToken
        ))
        let workspaceOnlyList = try await workspaceOnly.listWorkspaces()
        XCTAssertEqual(workspaceOnlyList, ["project"])
        do {
            _ = try await workspaceOnly.listThreads(workspaceID: "project")
            XCTFail("A workspace-only grant must not list Threads")
        } catch { }
        do {
            _ = try await workspaceOnly.listArtifacts(threadID: "thread-1")
            XCTFail("A workspace-only grant must not list artifacts")
        } catch { }
        workspaceOnly.close()

        let client = try RemoteClient(settings: RemoteSettings(
            origin: setup.origin, certificateSha256: setup.fingerprint, token: setup.token
        ))
        let expectedArtifactText = String(repeating: "A", count: 16_383) + "中文 artifact"
        let workspaces = try await client.listWorkspaces()
        let threads = try await client.listThreads(workspaceID: "project")
        XCTAssertEqual(workspaces, ["project"])
        XCTAssertEqual(threads.map(\.threadId), ["thread-1"])
        let artifactPage = try await client.listArtifacts(threadID: "thread-1")
        XCTAssertEqual(artifactPage.artifacts.map(\.id), [setup.artifactId])
        XCTAssertFalse(artifactPage.hasEarlier)
        let firstRange = try await client.readArtifact(
            threadID: "thread-1", artifactID: setup.artifactId
        )
        XCTAssertEqual(firstRange.startByte, 0)
        XCTAssertTrue(firstRange.hasLater)
        let secondRange = try await client.readArtifact(
            threadID: "thread-1", artifactID: setup.artifactId,
            afterByte: firstRange.endByte
        )
        XCTAssertEqual(secondRange.startByte, firstRange.endByte)
        XCTAssertFalse(secondRange.hasLater)
        XCTAssertEqual(firstRange.content + secondRange.content, expectedArtifactText)
        do {
            _ = try await client.readArtifact(
                threadID: "thread-1", artifactID: "sha256:" + String(repeating: "f", count: 64)
            )
            XCTFail("An unreferenced artifact must not be readable")
        } catch { }
        let started = try await client.startTurn(
            workspaceID: "project", prompt: "hello",
            requestID: String(repeating: "a", count: 32), resumeThreadID: "thread-1"
        )
        XCTAssertEqual(started.turnId, "turn-2")
        let replayed = try await client.startTurn(
            workspaceID: "project", prompt: "hello",
            requestID: String(repeating: "a", count: 32), resumeThreadID: "thread-1"
        )
        XCTAssertEqual(replayed.turnId, started.turnId)

        let first = try client.subscribe(threadID: "thread-1", after: -1)
        let initial = try await receiveFrames(4, from: first)
        XCTAssertEqual(initial.compactMap { $0.event?.text }, ["first", "second"])
        XCTAssertEqual(initial.last?.nextAfterSequence, 3)
        first.cancel(with: .goingAway, reason: nil)

        let resumed = try client.subscribe(threadID: "thread-1", after: 1)
        let remaining = try await receiveFrames(3, from: resumed)
        XCTAssertEqual(remaining.first?.event?.text, "second")
        XCTAssertEqual(remaining[1].event?.type, "turn.completed")
        XCTAssertEqual(remaining.last?.nextAfterSequence, 3)
        resumed.cancel(with: .goingAway, reason: nil)
        let noControl = try RemoteClient(settings: RemoteSettings(
            origin: setup.origin, certificateSha256: setup.fingerprint,
            token: setup.workspaceOnlyToken
        ))
        do {
            try await noControl.cancelTurn(threadID: "thread-1", turnID: "turn-2")
            XCTFail("A device without turn:control must not cancel a Turn")
        } catch { }
        noControl.close()
        try await client.cancelTurn(threadID: "thread-1", turnID: "turn-2")
        client.close()

        let reconnectModel = await RemoteModel()
        await reconnectModel.connect(RemoteSettings(
            origin: setup.origin, certificateSha256: setup.fingerprint, token: setup.token
        ), save: false)
        for _ in 0..<50 {
            if await reconnectModel.connected { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        let connected = await reconnectModel.connected
        XCTAssertTrue(connected)
        await reconnectModel.selectThread("thread-1")
        for _ in 0..<50 {
            if await reconnectModel.artifacts.map(\.id) == [setup.artifactId] { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        let listed = await reconnectModel.artifacts.map(\.id)
        XCTAssertEqual(listed, [setup.artifactId])
        await reconnectModel.openArtifact(setup.artifactId)
        for _ in 0..<50 {
            if await reconnectModel.artifactHasLater { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        let firstPreview = await reconnectModel.artifactText
        XCTAssertFalse(firstPreview.isEmpty)
        await reconnectModel.loadMoreArtifact()
        for _ in 0..<50 {
            let preview = await (reconnectModel.artifactHasLater,
                                 reconnectModel.artifactText)
            if !preview.0 && preview.1 == expectedArtifactText { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        let fullPreview = await reconnectModel.artifactText
        XCTAssertEqual(fullPreview, expectedArtifactText)
        for _ in 0..<50 {
            if await reconnectModel.entries.first?.text == "firstsecond" { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        let before = await reconnectModel.entries.map(\.text)
        XCTAssertEqual(before, ["firstsecond"])
        control.fileHandleForWriting.write(Data("restart\n".utf8))
        for _ in 0..<100 {
            if await reconnectModel.entries.contains(where: { $0.text == "after reconnect" }) { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        let after = await reconnectModel.entries.map(\.text)
        XCTAssertEqual(after, ["firstsecond", "after reconnect"])
        await reconnectModel.close()
        let closed = await (reconnectModel.connected, reconnectModel.entries.count)
        XCTAssertFalse(closed.0)
        XCTAssertEqual(closed.1, 0)
    }

    private func receiveFrames(
        _ count: Int, from socket: URLSessionWebSocketTask
    ) async throws -> [RemoteSubscriptionFrame] {
        var frames: [RemoteSubscriptionFrame] = []
        for _ in 0..<count {
            let message = try await socket.receive()
            let data: Data
            switch message {
            case .string(let text): data = Data(text.utf8)
            case .data(let bytes): data = bytes
            @unknown default: throw RemoteError(message: "Unknown WebSocket frame")
            }
            frames.append(try JSONDecoder().decode(RemoteSubscriptionFrame.self, from: data))
        }
        return frames
    }

    private func run(_ command: String, _ arguments: [String]) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [command] + arguments
        process.standardOutput = Pipe()
        process.standardError = Pipe()
        try process.run()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0)
    }
}

private struct FixtureSetup: Decodable {
    let origin: String
    let fingerprint: String
    let token: String
    let workspaceOnlyToken: String
    let artifactId: String
}
