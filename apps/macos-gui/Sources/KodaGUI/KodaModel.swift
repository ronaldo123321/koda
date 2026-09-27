import Combine
import Foundation

struct ProviderOption: Identifiable {
    let id: String
    let name: String
    let defaultModel: String
    let credentialName: String
    let configured: Bool
}

struct ThreadRow: Identifiable {
    let id: String
    let status: String
    let updatedAt: String
}

struct ChatEntry: Identifiable {
    let id: String
    let role: String
    let text: String
}

struct ApprovalRequest: Identifiable {
    let id: String
    let turnID: String
    let title: String
    let summary: String
    let details: String
    let reason: String
}

@MainActor
final class KodaModel: ObservableObject {
    @Published var connected = false
    @Published var workspace: URL?
    @Published var threads: [ThreadRow] = []
    @Published var selectedThreadID: String?
    @Published var entries: [ChatEntry] = []
    @Published var streamingText = ""
    @Published var prompt = ""
    @Published var providers: [ProviderOption] = []
    @Published var selectedProviderID = ""
    @Published var modelName = ""
    @Published var activeTurnID: String?
    @Published var approval: ApprovalRequest?
    @Published var notice: String?

    private var connection: AppServerConnection?
    private var finishedTurns = Set<String>()

    var selectedProvider: ProviderOption? {
        providers.first { $0.id == selectedProviderID }
    }

    var canSend: Bool {
        connected && workspace != nil && activeTurnID == nil &&
            selectedProvider?.configured == true &&
            !modelName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    func connect() {
        guard connection == nil else { return }
        let arguments = CommandLine.arguments
        let path: String?
        if let index = arguments.firstIndex(of: "--koda"), arguments.indices.contains(index + 1) {
            path = arguments[index + 1]
        } else {
            let bundled = Bundle.main.resourceURL?
                .appendingPathComponent("runtime/koda/bin/koda").path
            if let bundled, FileManager.default.isExecutableFile(atPath: bundled) {
                path = bundled
            } else {
                path = ProcessInfo.processInfo.environment["KODA_GUI_KODA_PATH"]
            }
        }
        do {
            let client = try AppServerConnection(kodaPath: path)
            connection = client
            client.onNotification = { [weak self] method, params in
                self?.handleNotification(method, params)
            }
            client.onDisconnect = { [weak self, weak client] in
                guard let self, let client, self.connection === client else { return }
                self.connection = nil
                self.connected = false
                self.activeTurnID = nil
                self.notice = "app-server 已断开。请重新连接。"
            }
            client.request("initialize", params: [
                "protocolVersion": 18,
                "client": ["name": "koda-macos-gui", "version": "0.1.0"],
            ]) { [weak self] response in
                guard let self else { return }
                switch response {
                case .failure(let error): self.notice = error.localizedDescription
                case .success(let result):
                    guard result["protocolVersion"] as? Int == 18 else {
                        self.notice = "app-server 协议版本不兼容。"
                        return
                    }
                    self.providers = (result["providers"] as? [[String: Any]] ?? []).compactMap {
                        item in
                        guard
                            let id = item["id"] as? String,
                            let name = item["displayName"] as? String,
                            let model = item["defaultModel"] as? String,
                            let credential = item["credentialEnvironmentVariable"] as? String,
                            let configured = item["configured"] as? Bool
                        else { return nil }
                        return ProviderOption(
                            id: id, name: name, defaultModel: model,
                            credentialName: credential, configured: configured
                        )
                    }
                    let preferred = self.providers.first { $0.configured } ?? self.providers.first
                    self.selectedProviderID = preferred?.id ?? ""
                    self.modelName = preferred?.defaultModel ?? ""
                    self.connected = true
                    self.notice = nil
                }
            }
        } catch {
            notice = "无法启动 app-server：\(error.localizedDescription)"
        }
    }

    func reconnect() {
        connection?.stop()
        connection = nil
        connected = false
        connect()
    }

    func useWorkspace(_ url: URL) {
        workspace = url.resolvingSymlinksInPath()
        selectedThreadID = nil
        entries = []
        refreshThreads()
    }

    func chooseProvider(_ id: String) {
        selectedProviderID = id
        modelName = selectedProvider?.defaultModel ?? ""
    }

    func refreshThreads() {
        guard let workspace, let connection else { return }
        connection.request("thread/list", params: ["workspace": workspace.path, "limit": 100]) {
            [weak self] response in
            guard let self else { return }
            switch response {
            case .failure(let error): self.notice = error.localizedDescription
            case .success(let result):
                self.threads = (result["threads"] as? [[String: Any]] ?? []).compactMap { item in
                    guard
                        let id = item["threadId"] as? String,
                        let status = item["status"] as? String,
                        let updatedAt = item["updatedAt"] as? String
                    else { return nil }
                    return ThreadRow(id: id, status: status, updatedAt: updatedAt)
                }
            }
        }
    }

    func selectThread(_ id: String?) {
        selectedThreadID = id
        entries = []
        streamingText = ""
        guard let id, let connection else { return }
        connection.request("thread/events", params: ["threadId": id, "limit": 200]) {
            [weak self] response in
            guard let self, self.selectedThreadID == id else { return }
            switch response {
            case .failure(let error): self.notice = error.localizedDescription
            case .success(let result):
                let events = result["events"] as? [[String: Any]] ?? []
                let historical = events.compactMap(Self.entry)
                self.entries = historical + self.entries.filter { current in
                    !historical.contains(where: { $0.id == current.id })
                }
            }
        }
    }

    func startTurn() {
        guard canSend, let workspace, let connection else { return }
        let submitted = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        var params: [String: Any] = [
            "prompt": submitted,
            "cwd": workspace.path,
            "provider": selectedProviderID,
            "model": modelName,
            "approvalMode": "on-request",
        ]
        if let selectedThreadID { params["resumeThreadId"] = selectedThreadID }
        connection.request("turn/start", params: params) { [weak self] response in
            guard let self else { return }
            switch response {
            case .failure(let error): self.notice = error.localizedDescription
            case .success(let result):
                guard
                    let threadID = result["threadId"] as? String,
                    let turnID = result["turnId"] as? String
                else {
                    self.notice = "app-server 未返回 Turn 标识。"
                    return
                }
                self.prompt = ""
                self.activeTurnID = self.finishedTurns.remove(turnID) == nil ? turnID : nil
                self.selectThread(threadID)
                self.refreshThreads()
            }
        }
    }

    func cancelTurn() {
        guard let activeTurnID, let connection else { return }
        connection.request("turn/cancel", params: ["turnId": activeTurnID]) {
            [weak self] response in
            if case .failure(let error) = response { self?.notice = error.localizedDescription }
        }
    }

    func resolveApproval(approved: Bool) {
        guard let approval, let connection else { return }
        connection.request("approval/resolve", params: [
            "turnId": approval.turnID,
            "callId": approval.id,
            "decision": approved ? "approved" : "rejected",
        ]) { [weak self] response in
            guard let self else { return }
            switch response {
            case .failure(let error): self.notice = error.localizedDescription
            case .success: self.approval = nil
            }
        }
    }

    private func handleNotification(_ method: String, _ params: [String: Any]) {
        if method == "turn/finished" {
            let finished = params["turnId"] as? String
            if let finished { finishedTurns.insert(finished) }
            if finished == activeTurnID {
                if let finished { finishedTurns.remove(finished) }
                activeTurnID = nil
                streamingText = ""
                approval = nil
                selectThread(selectedThreadID)
                refreshThreads()
            }
            return
        }
        guard method == "turn/event", let event = params["event"] as? [String: Any] else {
            return
        }
        let type = event["type"] as? String ?? ""
        let payload = event["payload"] as? [String: Any] ?? [:]
        if type == "approval.requested" {
            guard
                let callID = payload["callId"] as? String,
                let turnID = event["turnId"] as? String
            else { return }
            approval = ApprovalRequest(
                id: callID, turnID: turnID,
                title: payload["title"] as? String ?? "工具调用审批",
                summary: payload["summary"] as? String ?? "",
                details: payload["details"] as? String ?? "",
                reason: payload["reason"] as? String ?? ""
            )
        } else if type == "approval.resolved", payload["callId"] as? String == approval?.id {
            approval = nil
        }
        guard event["threadId"] as? String == selectedThreadID else { return }
        switch type {
        case "assistant.delta":
            streamingText += payload["text"] as? String ?? ""
        case "item.recorded":
            if let entry = Self.entry(event), !entries.contains(where: { $0.id == entry.id }) {
                entries.append(entry)
                if entry.role == "assistant" { streamingText = "" }
            }
        default: break
        }
    }

    private static func entry(_ event: [String: Any]) -> ChatEntry? {
        guard
            event["type"] as? String == "item.recorded",
            let payload = event["payload"] as? [String: Any],
            let item = payload["item"] as? [String: Any],
            let id = item["id"] as? String,
            let type = item["type"] as? String
        else { return nil }
        switch type {
        case "user_message":
            return ChatEntry(id: id, role: "user", text: item["content"] as? String ?? "")
        case "assistant_message":
            return ChatEntry(id: id, role: "assistant", text: item["content"] as? String ?? "")
        default: return nil
        }
    }
}
