import Combine
import Foundation

struct RemoteChatEntry: Identifiable {
    let id: String
    var text: String
}

struct PendingRemoteStart: Codable {
    let origin: String
    let certificateSha256: String
    let workspaceID: String
    let prompt: String
    let requestID: String
    let resumeThreadID: String?
}

@MainActor
final class RemoteModel: ObservableObject {
    @Published var connected = false
    @Published var connecting = false
    @Published var endpoint = ""
    @Published var hasSavedConnection = false
    @Published var workspaces: [String] = []
    @Published var selectedWorkspaceID: String?
    @Published var threads: [RemoteThread] = []
    @Published var selectedThreadID: String?
    @Published var entries: [RemoteChatEntry] = []
    @Published var prompt = ""
    @Published var notice: String?
    @Published var hasPendingStart = false
    @Published var startRetrying = false

    private var client: RemoteClient?
    private var streamTask: Task<Void, Never>?
    private var socket: URLSessionWebSocketTask?
    private var cursor = -1
    private var lastRenderedSequence = -1
    private var pendingStart: PendingRemoteStart?

    var canSend: Bool {
        connected && selectedWorkspaceID != nil && !hasPendingStart &&
            !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    func connectSaved() {
        guard !connected && !connecting else { return }
        do {
            pendingStart = try RemoteSettingsStore.loadPendingStart()
            hasPendingStart = pendingStart != nil
            if let pendingStart { prompt = pendingStart.prompt }
            guard let settings = try RemoteSettingsStore.load() else { return }
            hasSavedConnection = true
            connect(settings, save: false)
        } catch {
            notice = error.localizedDescription
        }
    }

    func connect(_ settings: RemoteSettings, save: Bool) {
        guard !connecting else { return }
        connecting = true
        notice = nil
        Task {
            var candidate: RemoteClient?
            do {
                let connection = try RemoteClient(settings: settings)
                candidate = connection
                let ids = try await connection.listWorkspaces()
                if save { try RemoteSettingsStore.save(settings) }
                disconnect()
                client = candidate
                candidate = nil
                endpoint = settings.origin
                hasSavedConnection = hasSavedConnection || save
                workspaces = ids
                selectedWorkspaceID = ids.first
                connected = true
                connecting = false
                refreshThreads()
            } catch {
                candidate?.close()
                notice = "远程连接失败：\(error.localizedDescription)"
                connecting = false
            }
        }
    }

    func reconnect() {
        guard !connecting else { return }
        do {
            guard let settings = try RemoteSettingsStore.load() else {
                notice = "请先配置远程连接。"
                return
            }
            connect(settings, save: false)
        } catch {
            notice = error.localizedDescription
        }
    }

    func forgetConnection() {
        do {
            try RemoteSettingsStore.delete()
            disconnect()
            hasSavedConnection = false
            endpoint = ""
            notice = nil
        } catch {
            notice = error.localizedDescription
        }
    }

    func selectWorkspace(_ id: String) {
        guard workspaces.contains(id) else { return }
        stopStream()
        selectedWorkspaceID = id
        selectedThreadID = nil
        entries = []
        refreshThreads()
    }

    func refreshThreads() {
        guard let client, let workspaceID = selectedWorkspaceID else { return }
        Task {
            do {
                let rows = try await client.listThreads(workspaceID: workspaceID)
                guard self.client === client, self.selectedWorkspaceID == workspaceID else { return }
                threads = rows.sorted { $0.updatedAt > $1.updatedAt }
                if !hasPendingStart { notice = nil }
            } catch {
                guard self.client === client else { return }
                notice = error.localizedDescription
            }
        }
    }

    func selectThread(_ id: String?) {
        stopStream()
        selectedThreadID = id
        entries = []
        cursor = -1
        lastRenderedSequence = -1
        guard let id, let client else { return }
        streamTask = Task { await stream(threadID: id, client: client) }
    }

    func startTurn() {
        guard canSend, let workspaceID = selectedWorkspaceID, let client else { return }
        let request = PendingRemoteStart(
            origin: client.settings.origin,
            certificateSha256: client.settings.certificateSha256,
            workspaceID: workspaceID,
            prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines),
            requestID: UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased(),
            resumeThreadID: selectedThreadID
        )
        do {
            try RemoteSettingsStore.savePendingStart(request)
        } catch {
            notice = "无法保存请求 ID，未发送远程请求：\(error.localizedDescription)"
            return
        }
        pendingStart = request
        hasPendingStart = true
        retryStart()
    }

    func retryStart() {
        guard let pendingStart, let client, !startRetrying else { return }
        guard pendingStart.origin == client.settings.origin &&
                pendingStart.certificateSha256.lowercased() ==
                    client.settings.certificateSha256.lowercased() else {
            notice = "待确认请求属于另一台主机或证书；请连接原主机后重试。"
            return
        }
        startRetrying = true
        Task {
            defer { startRetrying = false }
            do {
                let result = try await client.startTurn(
                    workspaceID: pendingStart.workspaceID,
                    prompt: pendingStart.prompt,
                    requestID: pendingStart.requestID,
                    resumeThreadID: pendingStart.resumeThreadID
                )
                guard self.client === client else { return }
                if result.status == "reserved" {
                    notice = "请求已预留但启动结果未确认，请稍后重试同一请求。"
                    return
                }
                try RemoteSettingsStore.deletePendingStart()
                self.pendingStart = nil
                hasPendingStart = false
                prompt = ""
                notice = nil
                selectThread(result.threadId)
                refreshThreads()
            } catch {
                guard self.client === client else { return }
                notice = "请求结果未确认，请重试同一请求：\(error.localizedDescription)"
            }
        }
    }

    func abandonPendingStart() {
        guard !startRetrying else { return }
        do {
            try RemoteSettingsStore.deletePendingStart()
            pendingStart = nil
            hasPendingStart = false
            notice = "已放弃重试。若主机实际启动了 Turn，仍可从 Thread 列表查看。"
        } catch {
            notice = error.localizedDescription
        }
    }

    private func stream(threadID: String, client: RemoteClient) async {
        var delay: UInt64 = 1_000_000_000
        while !Task.isCancelled && self.client === client && selectedThreadID == threadID {
            var subscription: URLSessionWebSocketTask?
            do {
                let socket = try client.subscribe(threadID: threadID, after: cursor)
                subscription = socket
                self.socket = socket
                while !Task.isCancelled {
                    let message = try await socket.receive()
                    guard !Task.isCancelled, self.client === client,
                          selectedThreadID == threadID else { break }
                    let data: Data
                    switch message {
                    case .string(let text): data = Data(text.utf8)
                    case .data(let bytes): data = bytes
                    @unknown default: continue
                    }
                    let frame = try JSONDecoder().decode(RemoteSubscriptionFrame.self, from: data)
                    handle(frame, for: threadID)
                    delay = 1_000_000_000
                }
            } catch {
                if !Task.isCancelled && self.client === client &&
                    selectedThreadID == threadID {
                    notice = "远程订阅已断开，正在按游标重连。"
                }
            }
            subscription?.cancel(with: .goingAway, reason: nil)
            if let subscription, self.socket === subscription { self.socket = nil }
            if Task.isCancelled || self.client !== client ||
                selectedThreadID != threadID { return }
            try? await Task.sleep(nanoseconds: delay)
            delay = min(delay * 2, 10_000_000_000)
        }
    }

    func handle(_ frame: RemoteSubscriptionFrame, for threadID: String) {
        guard selectedThreadID == threadID else { return }
        if frame.kind == "cursor", let next = frame.nextAfterSequence {
            cursor = max(cursor, next)
            if notice == "远程订阅已断开，正在按游标重连。" { notice = nil }
            return
        }
        guard frame.kind == "update", let update = frame.event,
              update.sequence > lastRenderedSequence else { return }
        lastRenderedSequence = update.sequence
        switch update.type {
        case "assistant.delta":
            if let index = entries.firstIndex(where: { $0.id == update.turnId }) {
                entries[index].text += update.text ?? ""
            } else {
                entries.append(RemoteChatEntry(id: update.turnId, text: update.text ?? ""))
            }
        case "turn.failed":
            entries.append(RemoteChatEntry(
                id: "failure-\(update.sequence)", text: "Turn 失败：\(update.code ?? "未知错误")"
            ))
            refreshThreads()
        case "turn.completed", "turn.cancelled":
            refreshThreads()
        default: break
        }
    }

    private func stopStream() {
        streamTask?.cancel()
        streamTask = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
    }

    private func disconnect() {
        stopStream()
        client?.close()
        client = nil
        connected = false
        workspaces = []
        selectedWorkspaceID = nil
        threads = []
        selectedThreadID = nil
        entries = []
    }
}
