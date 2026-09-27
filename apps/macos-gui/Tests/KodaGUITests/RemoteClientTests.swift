import Foundation
import XCTest
@testable import KodaGUI

final class RemoteClientTests: XCTestCase {
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
        server.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        server.arguments = ["node", fixture.path, root.path, workspace.path,
                            certificate.path, key.path]
        server.standardOutput = output
        server.standardError = errors
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
        workspaceOnly.close()

        let client = try RemoteClient(settings: RemoteSettings(
            origin: setup.origin, certificateSha256: setup.fingerprint, token: setup.token
        ))
        let workspaces = try await client.listWorkspaces()
        let threads = try await client.listThreads(workspaceID: "project")
        XCTAssertEqual(workspaces, ["project"])
        XCTAssertEqual(threads.map(\.threadId), ["thread-1"])
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
        client.close()
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
}
