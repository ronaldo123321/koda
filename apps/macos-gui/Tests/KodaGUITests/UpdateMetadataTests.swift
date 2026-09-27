import CryptoKit
import Foundation
import XCTest
@testable import KodaGUI

final class UpdateMetadataTests: XCTestCase {
    func testNodeSignerAndSwiftVerifierRejectTampering() throws {
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
        let signer = Process()
        signer.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        signer.arguments = ["node", script.path, packageURL.path, "0.2.0", "arm64",
                            String(repeating: "a", count: 40), privateKeyURL.path,
                            publicKeyURL.path, metadataURL.path]
        signer.standardOutput = Pipe()
        signer.standardError = Pipe()
        try signer.run()
        signer.waitUntilExit()
        XCTAssertEqual(signer.terminationStatus, 0)

        let data = try Data(contentsOf: metadataURL)
        let metadata = try JSONDecoder().decode(UpdateMetadata.self, from: data)
        let verified = try metadata.verify(version: "0.2.0", architecture: "arm64",
                                           packageName: packageURL.lastPathComponent,
                                           publicKey: privateKey.publicKey.rawRepresentation)
        try verified.verifyPackage(at: packageURL)
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
    }
}
