import CryptoKit
import Foundation
import XCTest
@testable import KodaGUI

final class UpdateMetadataTests: XCTestCase {
    func testNodeSignerAndSwiftVerifierRejectTampering() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("koda-update-metadata-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let privateKey = Curve25519.Signing.PrivateKey()
        let derPrefix = Data([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05,
                              0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20])
        let pem = "-----BEGIN PRIVATE KEY-----\n" +
            (derPrefix + privateKey.rawRepresentation).base64EncodedString() +
            "\n-----END PRIVATE KEY-----\n"
        let privateKeyURL = root.appendingPathComponent("signing.pem")
        let publicKeyURL = root.appendingPathComponent("update-public-key.base64")
        let packageURL = root.appendingPathComponent("Koda-v0.2.0-darwin-arm64.pkg")
        let metadataURL = root.appendingPathComponent("Koda-v0.2.0-darwin-arm64.update.json")
        try pem.write(to: privateKeyURL, atomically: true, encoding: .utf8)
        try privateKey.publicKey.rawRepresentation.base64EncodedString()
            .write(to: publicKeyURL, atomically: true, encoding: .utf8)
        try Data("local package fixture".utf8).write(to: packageURL)

        let repository = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
        let script = repository.appendingPathComponent("apps/macos-gui/sign-update-metadata.mjs")
        let sourceCommit = String(repeating: "a", count: 40)
        XCTAssertEqual(try runNode(script, [packageURL.path, "0.2.0", "arm64", sourceCommit,
                                            privateKeyURL.path, publicKeyURL.path, metadataURL.path]), 0)
        let x64PackageURL = root.appendingPathComponent("Koda-v0.2.0-darwin-x64.pkg")
        let x64MetadataURL = root.appendingPathComponent("Koda-v0.2.0-darwin-x64.update.json")
        try Data("second architecture package".utf8).write(to: x64PackageURL)
        XCTAssertEqual(try runNode(script, [x64PackageURL.path, "0.2.0", "x64", sourceCommit,
                                            privateKeyURL.path, publicKeyURL.path, x64MetadataURL.path]), 0)
        let verifier = repository.appendingPathComponent("apps/macos-gui/verify-update-assets.mjs")
        let verifyArguments = [publicKeyURL.path, "0.2.0", sourceCommit,
                               packageURL.path, metadataURL.path,
                               x64PackageURL.path, x64MetadataURL.path]
        XCTAssertEqual(try runNode(verifier, verifyArguments), 0)
        XCTAssertNotEqual(try runNode(verifier, [publicKeyURL.path, "0.2.0",
                                                 String(repeating: "b", count: 40)] +
                                            Array(verifyArguments.dropFirst(3))), 0)

        let data = try Data(contentsOf: metadataURL)
        let metadata = try JSONDecoder().decode(UpdateMetadata.self, from: data)
        let verified = try metadata.verify(version: "0.2.0", architecture: "arm64",
                                           packageName: packageURL.lastPathComponent,
                                           publicKey: privateKey.publicKey.rawRepresentation)
        try verified.verifyPackage(at: packageURL)
        UpdatePackageURLProtocol.bytes = try Data(contentsOf: packageURL)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [UpdatePackageURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let candidate = ReleaseUpdate(
            version: "0.2.0", page: URL(string: "https://github.com/ronaldo123321/koda")!,
            packageName: packageURL.lastPathComponent,
            packageURL: URL(string: "https://updates.example.test/package.pkg")!,
            verifiedMetadata: verified
        )
        let staged = try await ReleaseUpdates.download(candidate, session: session)
        defer { try? FileManager.default.removeItem(at: staged.deletingLastPathComponent()) }
        XCTAssertEqual(try Data(contentsOf: staged), UpdatePackageURLProtocol.bytes)
        UpdatePackageURLProtocol.bytes = Data(repeating: 0x78, count: verified.packageSize)
        do {
            _ = try await ReleaseUpdates.download(candidate, session: session)
            XCTFail("Changed package bytes must fail after download")
        } catch {
            XCTAssertEqual(error.localizedDescription,
                           UpdateMetadataError.packageMismatch.localizedDescription)
        }
        UpdatePackageURLProtocol.bytes = Data(repeating: 0x78, count: verified.packageSize + 1)
        do {
            _ = try await ReleaseUpdates.download(candidate, session: session)
            XCTFail("An oversized package must fail")
        } catch {
            XCTAssertEqual(error.localizedDescription,
                           UpdateMetadataError.packageMismatch.localizedDescription)
        }
        UpdatePackageURLProtocol.statusCode = 404
        do {
            _ = try await ReleaseUpdates.download(candidate, session: session)
            XCTFail("An absent release asset must fail")
        } catch {
            XCTAssertEqual(error.localizedDescription,
                           UpdateMetadataError.downloadFailed.localizedDescription)
        }
        XCTAssertThrowsError(try metadata.verify(version: "0.2.0", architecture: "x64",
                                                 packageName: packageURL.lastPathComponent,
                                                 publicKey: privateKey.publicKey.rawRepresentation))
        XCTAssertThrowsError(try metadata.verify(version: "0.2.0", architecture: "arm64",
                                                 packageName: packageURL.lastPathComponent,
                                                 publicKey: Curve25519.Signing.PrivateKey()
                                                    .publicKey.rawRepresentation))

        var altered = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        altered["package_sha256"] = String(repeating: "0", count: 64)
        let alteredMetadata = try JSONDecoder().decode(
            UpdateMetadata.self, from: JSONSerialization.data(withJSONObject: altered)
        )
        XCTAssertThrowsError(try alteredMetadata.verify(
            version: "0.2.0", architecture: "arm64", packageName: packageURL.lastPathComponent,
            publicKey: privateKey.publicKey.rawRepresentation
        ))
        try Data(repeating: 0x78, count: verified.packageSize).write(to: packageURL)
        XCTAssertThrowsError(try verified.verifyPackage(at: packageURL))
        XCTAssertNotEqual(try runNode(verifier, verifyArguments), 0)
    }

    private func runNode(_ script: URL, _ arguments: [String]) throws -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node", script.path] + arguments
        process.standardOutput = Pipe()
        process.standardError = Pipe()
        try process.run()
        process.waitUntilExit()
        return process.terminationStatus
    }
}

private final class UpdatePackageURLProtocol: URLProtocol {
    static var bytes = Data()
    static var statusCode = 200

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == "updates.example.test"
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.statusCode,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Length": "\(Self.bytes.count)"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.bytes)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() { }
}
