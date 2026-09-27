import CryptoKit
import Foundation
import XCTest
@testable import KodaGUI

final class RemoteClientTests: XCTestCase {
    func testPinnedSelfSignedHTTPSAndAuthorizedList() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("koda-remote-client-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let certificate = root.appendingPathComponent("cert.pem")
        let key = root.appendingPathComponent("key.pem")
        let der = root.appendingPathComponent("cert.der")
        try run("openssl", [
            "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", key.path, "-out", certificate.path,
            "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
            "-addext", "extendedKeyUsage=serverAuth",
            "-days", "1",
        ])
        try run("openssl", [
            "x509", "-in", certificate.path, "-outform", "DER", "-out", der.path,
        ])
        let fingerprint = SHA256.hash(data: try Data(contentsOf: der))
            .map { String(format: "%02x", $0) }.joined()
        let token = "koda-r1.device-\(String(repeating: "a", count: 32)).\(String(repeating: "b", count: 43))"
        let wsModule = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("app-server/node_modules/ws")
        let script = """
        const fs = require('fs');
        const https = require('https');
        const WebSocket = require(process.argv[4]);
        const subscriptions = new WebSocket.Server({noServer:true});
        const server = https.createServer({
          key: fs.readFileSync(process.argv[1]),
          cert: fs.readFileSync(process.argv[2])
        }, (request, response) => {
          if (request.headers.authorization !== 'Bearer ' + process.argv[3]) {
            response.writeHead(401); response.end('{}'); return;
          }
          response.setHeader('content-type', 'application/json');
          if (request.url === '/v1/workspaces') {
            response.end(JSON.stringify({workspaces:['project']}));
          } else if (request.url === '/v1/workspaces/project/threads?limit=25') {
            response.end(JSON.stringify({threads:[{
              threadId:'thread-1', workspaceId:'project', status:'completed',
              updatedAt:'2026-09-27T00:00:00.000Z'
            }],hasMore:false,nextAfterThreadId:'thread-1'}));
          } else if (request.url === '/v1/workspaces/project/turns' &&
                     request.method === 'POST') {
            let body = '';
            request.on('data', (chunk) => body += chunk);
            request.on('end', () => {
              const payload = JSON.parse(body);
              if (payload.requestId !== 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' ||
                  payload.prompt !== 'hello' || payload.resumeThreadId !== 'thread-1') {
                response.writeHead(400); response.end('{}'); return;
              }
              response.writeHead(202);
              response.end(JSON.stringify({
                threadId:'thread-1', turnId:'turn-2', status:'started'
              }));
            });
          } else { response.writeHead(404); response.end('{}'); }
        });
        server.on('upgrade', (request, socket, head) => {
          if (request.url !== '/v1/threads/thread-1/subscribe?after=-1&limit=100' ||
              request.headers.authorization !== 'Bearer ' + process.argv[3]) {
            socket.destroy(); return;
          }
          subscriptions.handleUpgrade(request, socket, head, (client) => {
            client.send(JSON.stringify({kind:'update',event:{
              sequence:1,turnId:'turn-1',type:'assistant.delta',text:'hello'
            }}));
            client.send(JSON.stringify({kind:'cursor',nextAfterSequence:1}));
          });
        });
        server.listen(0, '127.0.0.1', () => {
          process.stdout.write(String(server.address().port) + '\\n');
        });
        """
        let server = Process()
        let output = Pipe()
        let errors = Pipe()
        server.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        server.arguments = ["node", "-e", script, key.path, certificate.path, token, wsModule.path]
        server.standardOutput = output
        server.standardError = errors
        try server.run()
        defer { server.terminate(); server.waitUntilExit() }
        var portText = ""
        while let data = try output.fileHandleForReading.read(upToCount: 1), !data.isEmpty {
            let character = String(decoding: data, as: UTF8.self)
            if character == "\n" { break }
            portText += character
        }
        guard let port = Int(portText) else {
            XCTFail("HTTPS fixture did not start: \(String(decoding: errors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self))")
            return
        }
        let origin = "https://127.0.0.1:\(port)"
        let wrong = try RemoteClient(settings: RemoteSettings(
            origin: origin, certificateSha256: String(repeating: "0", count: 64), token: token
        ))
        do {
            _ = try await wrong.listWorkspaces()
            XCTFail("A wrong certificate pin must fail")
        } catch { }
        wrong.close()
        let correct = try RemoteClient(settings: RemoteSettings(
            origin: origin, certificateSha256: fingerprint, token: token
        ))
        let workspaces = try await correct.listWorkspaces()
        let threads = try await correct.listThreads(workspaceID: "project")
        XCTAssertEqual(workspaces, ["project"])
        XCTAssertEqual(threads.map(\.threadId), ["thread-1"])
        let started = try await correct.startTurn(
            workspaceID: "project", prompt: "hello",
            requestID: String(repeating: "a", count: 32), resumeThreadID: "thread-1"
        )
        XCTAssertEqual(started.turnId, "turn-2")
        let socket = try correct.subscribe(threadID: "thread-1", after: -1)
        let first = try await socket.receive()
        let second = try await socket.receive()
        guard case .string(let updateText) = first,
              case .string(let cursorText) = second else {
            XCTFail("Remote subscription did not return text frames")
            return
        }
        let update = try JSONDecoder().decode(
            RemoteSubscriptionFrame.self, from: Data(updateText.utf8)
        )
        let cursor = try JSONDecoder().decode(
            RemoteSubscriptionFrame.self, from: Data(cursorText.utf8)
        )
        XCTAssertEqual(update.event?.text, "hello")
        XCTAssertEqual(cursor.nextAfterSequence, 1)
        socket.cancel(with: .goingAway, reason: nil)
        correct.close()
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
