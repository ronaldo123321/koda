import CryptoKit
import Foundation
import Security

struct RemoteSettings: Codable {
    let origin: String
    let certificateSha256: String
    let token: String
}

struct RemoteThread: Decodable, Identifiable {
    let threadId: String
    let workspaceId: String
    let status: String
    let updatedAt: String
    var id: String { threadId }
}

struct RemoteUpdate: Decodable {
    let sequence: Int
    let turnId: String
    let type: String
    let text: String?
    let code: String?
    var itemType: String? = nil
    var effect: String? = nil
    var status: String? = nil
    var outcome: String? = nil
    var decision: String? = nil
    var step: Int? = nil
    var steps: Int? = nil
    var exitCode: Int? = nil
}

struct RemoteSubscriptionFrame: Decodable {
    let kind: String
    let event: RemoteUpdate?
    let nextAfterSequence: Int?
}

struct RemoteTurnStart: Decodable {
    let threadId: String
    let turnId: String
    let status: String
}

struct RemoteApprovalPreview: Decodable, Identifiable {
    let turnId: String
    let callId: String
    let name: String
    let title: String
    let summary: String
    let details: String
    let reason: String
    let expiresAt: String
    var id: String { "\(turnId):\(callId)" }
}

private struct RemoteApprovalPage: Decodable {
    let approvals: [RemoteApprovalPreview]
}

private struct RemoteApprovalResolution: Decodable {
    let status: String
}

private struct RemoteTurnStartBody: Encodable {
    let requestId: String
    let prompt: String
    let resumeThreadId: String?
    let effects: [String]?
}

struct RemoteArtifact: Decodable, Identifiable {
    let id: String
    let sha256: String
    let bytes: Int
    let mediaType: String
}

struct RemoteArtifactDescriptor: Decodable, Identifiable {
    let sequence: Int
    let artifact: RemoteArtifact
    var id: String { artifact.id }
}

struct RemoteArtifactPage: Decodable {
    let artifacts: [RemoteArtifactDescriptor]
    let hasEarlier: Bool
    let nextBeforeSequence: Int?
}

struct RemoteArtifactRange: Decodable {
    let artifact: RemoteArtifact
    let content: String
    let startByte: Int
    let endByte: Int
    let totalBytes: Int
    let hasEarlier: Bool
    let hasLater: Bool
}

private struct RemoteTurnCancel: Decodable {
    let status: String
}

struct RemoteError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

final class RemoteClient: NSObject, URLSessionDelegate, URLSessionTaskDelegate {
    let settings: RemoteSettings
    private let origin: URL
    private let host: String
    private let fingerprint: String
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.timeoutIntervalForRequest = 15
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()

    init(settings: RemoteSettings) throws {
        guard
            let components = URLComponents(string: settings.origin),
            components.scheme == "https",
            let host = components.host, !host.isEmpty,
            components.user == nil, components.password == nil,
            components.path.isEmpty || components.path == "/",
            components.query == nil, components.fragment == nil,
            let url = components.url,
            settings.certificateSha256.range(
                of: "^[A-Fa-f0-9]{64}$", options: .regularExpression
            ) != nil,
            settings.token.range(
                of: "^koda-r1\\.device-[a-f0-9]{32}\\.[A-Za-z0-9_-]{43}$",
                options: .regularExpression
            ) != nil
        else { throw RemoteError(message: "远程地址、证书指纹或设备令牌格式不正确。") }
        self.settings = settings
        self.origin = url
        self.host = host
        self.fingerprint = settings.certificateSha256.lowercased()
    }

    func close() { session.invalidateAndCancel() }

    func listWorkspaces() async throws -> [String] {
        let result: WorkspaceList = try await get("/v1/workspaces")
        return result.workspaces
    }

    func listThreads(workspaceID: String) async throws -> [RemoteThread] {
        guard workspaceID.range(
            of: "^[a-z][a-z0-9-]{0,63}$", options: .regularExpression
        ) != nil else { throw RemoteError(message: "远程工作区 ID 无效。") }
        var threads: [RemoteThread] = []
        var after: String?
        repeat {
            let page: ThreadListPage = try await get(
                "/v1/workspaces/\(workspaceID)/threads",
                query: [URLQueryItem(name: "limit", value: "25")] +
                    (after.map { [URLQueryItem(name: "after", value: $0)] } ?? [])
            )
            threads.append(contentsOf: page.threads)
            guard page.hasMore else { break }
            guard threads.count < 10_000 else {
                throw RemoteError(message: "远程 Thread 列表超过客户端上限。")
            }
            guard let next = page.nextAfterThreadId, next != after else {
                throw RemoteError(message: "远程 Thread 分页游标无效。")
            }
            after = next
        } while threads.count < 10_000
        return threads
    }

    func startTurn(
        workspaceID: String, prompt: String, requestID: String, resumeThreadID: String?,
        effects: [String]? = nil
    ) async throws -> RemoteTurnStart {
        guard workspaceID.range(
            of: "^[a-z][a-z0-9-]{0,63}$", options: .regularExpression
        ) != nil else { throw RemoteError(message: "远程工作区 ID 无效。") }
        if let effects {
            guard !effects.isEmpty, effects.count <= 2,
                  effects.count == Set(effects).count,
                  effects.allSatisfy({ $0 == "workspace:mutate" || $0 == "process:control" }) else {
                throw RemoteError(message: "远程副作用范围无效。")
            }
        }
        let body = RemoteTurnStartBody(
            requestId: requestID, prompt: prompt,
            resumeThreadId: resumeThreadID, effects: effects
        )
        return try await perform(
            "/v1/workspaces/\(workspaceID)/turns", method: "POST",
            body: try JSONEncoder().encode(body),
            acceptedStatuses: [202, 409]
        )
    }

    func listApprovals(threadID: String) async throws -> [RemoteApprovalPreview] {
        guard validThreadID(threadID) else {
            throw RemoteError(message: "远程 Thread ID 无效。")
        }
        let page: RemoteApprovalPage = try await get("/v1/threads/\(threadID)/approvals")
        return page.approvals
    }

    func resolveApproval(
        threadID: String, turnID: String, callID: String,
        decision: String
    ) async throws {
        guard validThreadID(threadID), validThreadID(turnID),
              !callID.isEmpty, callID.utf8.count <= 256,
              decision == "approved" || decision == "rejected" else {
            throw RemoteError(message: "远程审批标识或决定无效。")
        }
        let body = ["turnId": turnID, "callId": callID, "decision": decision]
        let result: RemoteApprovalResolution = try await perform(
            "/v1/threads/\(threadID)/approvals/resolve", method: "POST",
            body: try JSONEncoder().encode(body), acceptedStatuses: [202]
        )
        guard result.status == "resolved" else {
            throw RemoteError(message: "远程审批响应无效。")
        }
    }

    func cancelTurn(threadID: String, turnID: String) async throws {
        guard [threadID, turnID].allSatisfy({
            $0.range(of: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
                     options: .regularExpression) != nil
        }) else { throw RemoteError(message: "远程 Turn 标识无效。") }
        let result: RemoteTurnCancel = try await perform(
            "/v1/threads/\(threadID)/turns/\(turnID)/cancel",
            method: "POST", acceptedStatuses: [202]
        )
        guard result.status == "cancel_requested" else {
            throw RemoteError(message: "远程停止响应无效。")
        }
    }

    func listArtifacts(threadID: String, beforeSequence: Int? = nil) async throws -> RemoteArtifactPage {
        guard validThreadID(threadID) else {
            throw RemoteError(message: "远程产物请求无效。")
        }
        if let beforeSequence, beforeSequence < 0 {
            throw RemoteError(message: "远程产物游标无效。")
        }
        return try await get(
            "/v1/threads/\(threadID)/artifacts",
            query: [URLQueryItem(name: "limit", value: "25")] +
                (beforeSequence.map { [URLQueryItem(name: "before", value: String($0))] } ?? [])
        )
    }

    func readArtifact(threadID: String, artifactID: String, afterByte: Int = 0) async throws -> RemoteArtifactRange {
        guard validThreadID(threadID), afterByte >= 0,
              artifactID.range(of: "^sha256:[a-f0-9]{64}$", options: .regularExpression) != nil else {
            throw RemoteError(message: "远程产物标识或游标无效。")
        }
        return try await get(
            "/v1/threads/\(threadID)/artifacts/\(artifactID)",
            query: [
                URLQueryItem(name: "afterByte", value: String(afterByte)),
                URLQueryItem(name: "maxBytes", value: "16384"),
            ]
        )
    }

    func subscribe(threadID: String, after: Int, activity: Bool = false) throws -> URLSessionWebSocketTask {
        guard validThreadID(threadID) else { throw RemoteError(message: "远程 Thread ID 无效。") }
        var components = URLComponents(url: origin, resolvingAgainstBaseURL: false)!
        components.scheme = "wss"
        components.path = "/v1/threads/\(threadID)/subscribe"
        components.queryItems = [
            URLQueryItem(name: "after", value: String(after)),
            URLQueryItem(name: "limit", value: "100"),
        ] + (activity ? [URLQueryItem(name: "view", value: "activity")] : [])
        guard let url = components.url else {
            throw RemoteError(message: "远程订阅地址无效。")
        }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(settings.token)", forHTTPHeaderField: "Authorization")
        let task = session.webSocketTask(with: request)
        task.resume()
        return task
    }

    private func validThreadID(_ value: String) -> Bool {
        value.range(of: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$", options: .regularExpression) != nil
    }

    private func get<T: Decodable>(
        _ path: String, query: [URLQueryItem] = []
    ) async throws -> T {
        try await perform(path, method: "GET", query: query)
    }

    private func perform<T: Decodable>(
        _ path: String, method: String, query: [URLQueryItem] = [],
        body: Data? = nil, acceptedStatuses: Set<Int> = [200]
    ) async throws -> T {
        var components = URLComponents(url: origin, resolvingAgainstBaseURL: false)!
        components.path = path
        components.queryItems = query.isEmpty ? nil : query
        guard let url = components.url else {
            throw RemoteError(message: "远程请求地址无效。")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(settings.token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse,
              acceptedStatuses.contains(response.statusCode) else {
            throw RemoteError(message: "远程请求未获授权或失败。")
        }
        guard data.count <= 3 * 1_024 * 1_024 else {
            throw RemoteError(message: "远程响应过大。")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    func urlSession(
        _ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        handle(challenge, completionHandler: completionHandler)
    }

    func urlSession(
        _ session: URLSession, task: URLSessionTask,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        handle(challenge, completionHandler: completionHandler)
    }

    private func handle(
        _ challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard
            challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
            challenge.protectionSpace.host == host,
            let trust = challenge.protectionSpace.serverTrust,
            let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
            let leaf = chain.first
        else { completionHandler(.cancelAuthenticationChallenge, nil); return }
        let digest = SHA256.hash(data: SecCertificateCopyData(leaf) as Data)
            .map { String(format: "%02x", $0) }.joined()
        guard digest == fingerprint else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        let policyStatus = SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, host as CFString))
        let anchorStatus = SecTrustSetAnchorCertificates(trust, [leaf] as CFArray)
        let anchorOnlyStatus = SecTrustSetAnchorCertificatesOnly(trust, true)
        let trusted = SecTrustEvaluateWithError(trust, nil)
        guard policyStatus == errSecSuccess, anchorStatus == errSecSuccess,
              anchorOnlyStatus == errSecSuccess, trusted else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    func urlSession(
        _ session: URLSession, task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

private struct WorkspaceList: Decodable { let workspaces: [String] }
private struct ThreadListPage: Decodable {
    let threads: [RemoteThread]
    let hasMore: Bool
    let nextAfterThreadId: String?
}
