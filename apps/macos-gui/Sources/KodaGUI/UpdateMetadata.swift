import CryptoKit
import Foundation

struct UpdateMetadata: Decodable {
    let schemaVersion: Int
    let version: String
    let architecture: String
    let sourceCommit: String
    let packageName: String
    let packageSize: Int
    let packageSha256: String
    let signature: String

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version", version, architecture
        case sourceCommit = "source_commit", packageName = "package_name"
        case packageSize = "package_size", packageSha256 = "package_sha256", signature
    }

    func verify(version expectedVersion: String, architecture expectedArchitecture: String,
                packageName expectedPackageName: String, publicKey: Data) throws -> VerifiedUpdateMetadata {
        guard schemaVersion == 1, version == expectedVersion,
              architecture == expectedArchitecture, packageName == expectedPackageName,
              sourceCommit.range(of: "^[a-f0-9]{40}$", options: .regularExpression) != nil,
              packageSha256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              packageSize > 0, packageSize <= 2_000_000_000,
              let signatureData = Data(base64Encoded: signature), signatureData.count == 64,
              publicKey.count == 32 else { throw UpdateMetadataError.invalid }
        let key = try Curve25519.Signing.PublicKey(rawRepresentation: publicKey)
        guard key.isValidSignature(signatureData, for: Data(signedMessage.utf8)) else {
            throw UpdateMetadataError.invalid
        }
        return VerifiedUpdateMetadata(packageSize: packageSize, packageSha256: packageSha256)
    }

    var signedMessage: String {
        "KODA_GUI_UPDATE_V1\n\(version)\n\(architecture)\n\(sourceCommit)\n" +
            "\(packageName)\n\(packageSize)\n\(packageSha256)\n"
    }
}

struct VerifiedUpdateMetadata {
    let packageSize: Int
    let packageSha256: String

    fileprivate init(packageSize: Int, packageSha256: String) {
        self.packageSize = packageSize
        self.packageSha256 = packageSha256
    }

    func verifyPackage(at url: URL) throws {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hash = SHA256()
        var size = 0
        while let chunk = try handle.read(upToCount: 64 * 1024), !chunk.isEmpty {
            size += chunk.count
            if size > packageSize { throw UpdateMetadataError.packageMismatch }
            hash.update(data: chunk)
        }
        guard size == packageSize,
              hash.finalize().map({ String(format: "%02x", $0) }).joined() == packageSha256
        else { throw UpdateMetadataError.packageMismatch }
    }
}

enum UpdateMetadataError: LocalizedError {
    case invalid
    case missingTrustRoot
    case downloadFailed
    case packageMismatch

    var errorDescription: String? {
        switch self {
        case .invalid: "应用更新元数据签名或内容无效。"
        case .missingTrustRoot: "此版本尚未配置应用更新信任密钥。"
        case .downloadFailed: "更新包下载失败。"
        case .packageMismatch: "更新包大小或摘要不匹配。"
        }
    }
}
