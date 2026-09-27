import Foundation

struct ReleaseUpdate {
    let version: String
    let page: URL
    let packageName: String
    let packageURL: URL
    let verifiedMetadata: VerifiedUpdateMetadata
}

struct ReleaseCandidate {
    let version: String
    let page: URL
    let packageName: String
    let packageURL: URL
    let metadataURL: URL
}

enum ReleaseUpdates {
    private static let endpoint = URL(string:
        "https://api.github.com/repos/ronaldo123321/koda/releases?per_page=30"
    )!

    static func check(installedVersion: String, session: URLSession = .shared) async throws -> ReleaseUpdate? {
        var request = URLRequest(url: endpoint)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("Koda-macOS-update-check", forHTTPHeaderField: "User-Agent")
        request.timeoutInterval = 15
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200,
              data.count <= 1_000_000 else {
            throw UpdateCheckError.invalidResponse
        }
        guard let candidate = try select(from: data, installedVersion: installedVersion,
                                         architecture: currentArchitecture) else { return nil }
        let publicKey = try loadTrustRoot()
        let (metadataBytes, metadataResponse) = try await session.bytes(from: candidate.metadataURL)
        guard let http = metadataResponse as? HTTPURLResponse, http.statusCode == 200
        else { throw UpdateMetadataError.invalid }
        var metadataData = Data()
        for try await byte in metadataBytes {
            guard metadataData.count < 8_192 else { throw UpdateMetadataError.invalid }
            metadataData.append(byte)
        }
        let metadata = try JSONDecoder().decode(UpdateMetadata.self, from: metadataData)
        return ReleaseUpdate(version: candidate.version, page: candidate.page,
                             packageName: candidate.packageName,
                             packageURL: candidate.packageURL,
                             verifiedMetadata: try metadata.verify(
                                version: candidate.version, architecture: currentArchitecture,
                                packageName: candidate.packageName, publicKey: publicKey))
    }

    static func download(_ update: ReleaseUpdate, session: URLSession = .shared) async throws -> URL {
        var request = URLRequest(url: update.packageURL)
        request.setValue("Koda-macOS-update-download", forHTTPHeaderField: "User-Agent")
        request.timeoutInterval = 300
        let limiter = BoundedDownloadDelegate(maxBytes: update.verifiedMetadata.packageSize)
        let downloadedURL: URL
        let response: URLResponse
        do {
            (downloadedURL, response) = try await session.download(for: request, delegate: limiter)
        } catch {
            if limiter.exceeded { throw UpdateMetadataError.packageMismatch }
            throw error
        }
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw UpdateMetadataError.downloadFailed
        }
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("koda-update-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
                                                attributes: [.posixPermissions: 0o700])
        do {
            let packageURL = directory.appendingPathComponent(update.packageName)
            try FileManager.default.moveItem(at: downloadedURL, to: packageURL)
            try update.verifiedMetadata.verifyPackage(at: packageURL)
            return packageURL
        } catch {
            try? FileManager.default.removeItem(at: directory)
            throw error
        }
    }

    static func select(from data: Data, installedVersion: String,
                       architecture: String) throws -> ReleaseCandidate? {
        guard let installed = Version(installedVersion) else { throw UpdateCheckError.invalidVersion }
        let releases = try JSONDecoder().decode([Release].self, from: data)
        return releases.compactMap { release -> (Version, ReleaseCandidate)? in
            guard !release.draft, release.tagName.hasPrefix("v"),
                  let version = Version(String(release.tagName.dropFirst())),
                  version > installed,
                  let page = URL(string: release.htmlURL),
                  page.scheme == "https", page.host == "github.com",
                  page.user == nil, page.password == nil,
                  page.query == nil, page.fragment == nil,
                  page.path == "/ronaldo123321/koda/releases/tag/\(release.tagName)" else { return nil }
            let base = "Koda-\(release.tagName)-darwin-\(architecture)"
            let packageName = "\(base).pkg"
            let metadataName = "\(base).update.json"
            let downloadBase = "https://github.com/ronaldo123321/koda/releases/download/\(release.tagName)/"
            guard let packageAsset = release.assets.first(where: {
                $0.name == packageName && $0.state == "uploaded" &&
                    $0.browserDownloadURL == downloadBase + packageName
            }), let metadataAsset = release.assets.first(where: {
                $0.name == metadataName && $0.state == "uploaded" &&
                    $0.browserDownloadURL == downloadBase + metadataName
            }), let packageURL = URL(string: packageAsset.browserDownloadURL),
               let metadataURL = URL(string: metadataAsset.browserDownloadURL)
            else { return nil }
            return (version, ReleaseCandidate(version: String(release.tagName.dropFirst()),
                                              page: page, packageName: packageName,
                                              packageURL: packageURL, metadataURL: metadataURL))
        }.max(by: { $0.0 < $1.0 })?.1
    }

    private static func loadTrustRoot() throws -> Data {
        guard let url = Bundle.main.url(forResource: "update-public-key", withExtension: "base64"),
              let encoded = try? String(contentsOf: url, encoding: .utf8),
              let key = Data(base64Encoded: encoded.trimmingCharacters(in: .whitespacesAndNewlines)),
              key.count == 32 else { throw UpdateMetadataError.missingTrustRoot }
        return key
    }

    private static var currentArchitecture: String {
        #if arch(arm64)
        "arm64"
        #elseif arch(x86_64)
        "x64"
        #else
        "unsupported"
        #endif
    }
}

private final class BoundedDownloadDelegate: NSObject, URLSessionDownloadDelegate {
    private let maxBytes: Int64
    private let lock = NSLock()
    private var exceededLimit = false

    init(maxBytes: Int) { self.maxBytes = Int64(maxBytes) }

    var exceeded: Bool {
        lock.lock()
        defer { lock.unlock() }
        return exceededLimit
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didWriteData bytesWritten: Int64, totalBytesWritten: Int64,
                    totalBytesExpectedToWrite: Int64) {
        if totalBytesWritten > maxBytes || totalBytesExpectedToWrite > maxBytes {
            lock.lock()
            exceededLimit = true
            lock.unlock()
            downloadTask.cancel()
        }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didFinishDownloadingTo location: URL) { }
}

private struct Release: Decodable {
    let tagName: String
    let htmlURL: String
    let draft: Bool
    let assets: [Asset]

    enum CodingKeys: String, CodingKey {
        case tagName = "tag_name", htmlURL = "html_url", draft, assets
    }
}

private struct Asset: Decodable {
    let name: String
    let state: String
    let browserDownloadURL: String

    enum CodingKeys: String, CodingKey {
        case name, state, browserDownloadURL = "browser_download_url"
    }
}

private struct Version: Comparable {
    let parts: [Int]
    let prerelease: [String]

    init?(_ value: String) {
        let sections = value.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        let numbers = sections[0].split(separator: ".", omittingEmptySubsequences: false)
        guard numbers.count == 3,
              numbers.allSatisfy({ !$0.isEmpty && $0.allSatisfy(\.isNumber) }),
              let major = Int(numbers[0]), let minor = Int(numbers[1]),
              let patch = Int(numbers[2]) else { return nil }
        parts = [major, minor, patch]
        if sections.count == 2 {
            let labels = sections[1].split(separator: ".", omittingEmptySubsequences: false)
            guard labels.allSatisfy({ !$0.isEmpty && $0.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }) })
            else { return nil }
            prerelease = labels.map(String.init)
        } else {
            prerelease = []
        }
    }

    static func < (lhs: Version, rhs: Version) -> Bool {
        if lhs.parts != rhs.parts { return lhs.parts.lexicographicallyPrecedes(rhs.parts) }
        if lhs.prerelease.isEmpty { return false }
        if rhs.prerelease.isEmpty { return true }
        for (a, b) in zip(lhs.prerelease, rhs.prerelease) {
            if a == b { continue }
            if let an = Int(a), let bn = Int(b) { return an < bn }
            if Int(a) != nil { return true }
            if Int(b) != nil { return false }
            return a < b
        }
        return lhs.prerelease.count < rhs.prerelease.count
    }
}

private enum UpdateCheckError: LocalizedError {
    case invalidResponse
    case invalidVersion

    var errorDescription: String? {
        switch self {
        case .invalidResponse: "GitHub Releases 响应无效或暂不可用。"
        case .invalidVersion: "当前应用版本无效。"
        }
    }
}
