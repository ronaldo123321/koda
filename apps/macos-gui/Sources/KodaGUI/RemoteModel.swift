import Combine
import Foundation

struct RemoteChatEntry: Identifiable {
    let id: String
    var text: String
    var isActivity = false
    var turnID: String? = nil
}

struct PendingRemoteStart: Codable {
    let origin: String
    let certificateSha256: String
    let workspaceID: String
    let prompt: String
    let requestID: String
    let resumeThreadID: String?
    let effects: [String]?
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
    @Published var allowWrites = false
    @Published var allowCommands = false
    @Published var allowMcp = false
    @Published var notice: String?
    @Published var hasPendingStart = false
    @Published var startRetrying = false
    @Published var activeTurns: [String: String] = [:]
    @Published var stopPendingTurns = Set<String>()
    @Published var approvals: [RemoteApprovalPreview] = []
    @Published var selectedApproval: RemoteApprovalPreview? {
        didSet {
            if oldValue?.id != selectedApproval?.id { approvalTransferDeviceID = "" }
        }
    }
    @Published var approvalTransferDeviceID = ""
    @Published var approvalBusy = false
    @Published var artifacts: [RemoteArtifactDescriptor] = []
    @Published var artifactListBusy = false
    @Published var hasEarlierArtifacts = false
    @Published var selectedArtifactID: String?
    @Published var artifactText = ""
    @Published var artifactEndByte = 0
    @Published var artifactHasLater = false
    @Published var artifactBusy = false
    @Published var artifactNotice: String?

    private var client: RemoteClient?
    private var connectTask: Task<Void, Never>?
    private var connectionGeneration = 0
    private var streamTask: Task<Void, Never>?
    private var socket: URLSessionWebSocketTask?
    private var cursor = -1
    private var lastRenderedSequence = -1
    private var pendingStart: PendingRemoteStart?
    private var artifactGeneration = 0
    private var artifactReadGeneration = 0
    private var nextBeforeArtifactSequence: Int?
    private var approvalGeneration = 0

    var canSend: Bool {
        connected && selectedWorkspaceID != nil && !hasPendingStart &&
            !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var canCancel: Bool {
        guard connected, let selectedThreadID,
              let turnID = activeTurns[selectedThreadID] else { return false }
        return !stopPendingTurns.contains(turnID)
    }

    var deviceID: String? {
        guard let token = client?.settings.token else { return nil }
        let parts = token.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0] == "koda-r1" else { return nil }
        return String(parts[1])
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
        connectionGeneration += 1
        let generation = connectionGeneration
        connecting = true
        notice = nil
        connectTask = Task {
            var candidate: RemoteClient?
            do {
                let connection = try RemoteClient(settings: settings)
                candidate = connection
                let ids = try await connection.listWorkspaces()
                guard generation == connectionGeneration, !Task.isCancelled else {
                    candidate?.close()
                    return
                }
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
                connectTask = nil
                refreshThreads()
            } catch {
                candidate?.close()
                guard generation == connectionGeneration else { return }
                notice = "远程连接失败：\(error.localizedDescription)"
                connecting = false
                connectTask = nil
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
        cancelPendingConnection()
        do {
            try RemoteSettingsStore.delete()
            disconnect()
            hasSavedConnection = false
            endpoint = ""
            do {
                try RemoteSettingsStore.deletePendingStart()
                pendingStart = nil
                hasPendingStart = false
                prompt = ""
                notice = nil
            } catch {
                notice = "已删除远程令牌，但待确认请求未清除：\(error.localizedDescription)"
            }
        } catch {
            notice = error.localizedDescription
        }
    }

    func cancelPendingConnection() {
        connectionGeneration += 1
        connectTask?.cancel()
        connectTask = nil
        connecting = false
    }

    func close() {
        cancelPendingConnection()
        disconnect()
    }

    func selectWorkspace(_ id: String) {
        guard workspaces.contains(id) else { return }
        stopStream()
        selectedWorkspaceID = id
        selectedThreadID = nil
        entries = []
        approvals = []
        selectedApproval = nil
        resetArtifacts()
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
        resetArtifacts()
        selectedThreadID = id
        entries = []
        approvals = []
        selectedApproval = nil
        cursor = -1
        lastRenderedSequence = -1
        guard let id, let client else { return }
        refreshArtifacts()
        refreshApprovals()
        streamTask = Task { await stream(threadID: id, client: client) }
    }

    func refreshApprovals() {
        approvalGeneration += 1
        let generation = approvalGeneration
        guard let client, let threadID = selectedThreadID else {
            approvals = []
            return
        }
        Task {
            do {
                let pending = try await client.listApprovals(threadID: threadID)
                guard self.client === client, selectedThreadID == threadID,
                      approvalGeneration == generation else { return }
                approvals = pending
                if let selectedApproval,
                   !pending.contains(where: { $0.id == selectedApproval.id }) {
                    self.selectedApproval = nil
                }
            } catch {
                guard self.client === client, selectedThreadID == threadID,
                      approvalGeneration == generation else { return }
                approvals = []
                selectedApproval = nil
            }
        }
    }

    func resolveApproval(_ decision: String) {
        guard !approvalBusy, let client, let threadID = selectedThreadID,
              let approval = selectedApproval else { return }
        approvalBusy = true
        Task {
            defer { approvalBusy = false }
            do {
                try await client.resolveApproval(
                    threadID: threadID, turnID: approval.turnId,
                    callID: approval.callId, decision: decision
                )
                guard self.client === client, selectedThreadID == threadID else { return }
                selectedApproval = nil
                notice = decision == "approved" ? "审批已提交，等待主机执行。" : "审批已拒绝。"
                refreshApprovals()
            } catch {
                guard self.client === client, selectedThreadID == threadID else { return }
                notice = "审批结果未确认；请查看待审批项与事件记录，不会自动重试：\(error.localizedDescription)"
                refreshApprovals()
            }
        }
    }

    func transferApproval() {
        guard !approvalBusy, let client, let threadID = selectedThreadID,
              let approval = selectedApproval else { return }
        let targetDeviceID = approvalTransferDeviceID.trimmingCharacters(in: .whitespacesAndNewlines)
        approvalBusy = true
        Task {
            defer { approvalBusy = false }
            do {
                try await client.transferApproval(
                    threadID: threadID, turnID: approval.turnId,
                    callID: approval.callId, targetDeviceID: targetDeviceID
                )
                guard self.client === client, selectedThreadID == threadID else { return }
                selectedApproval = nil
                approvalTransferDeviceID = ""
                notice = "审批已转交给目标设备；目标设备仍须逐项预览并决定。"
                refreshApprovals()
            } catch {
                guard self.client === client, selectedThreadID == threadID else { return }
                notice = "审批转交未确认；请刷新待审批项，不会自动重试：\(error.localizedDescription)"
                refreshApprovals()
            }
        }
    }

    func refreshArtifacts() {
        artifactGeneration += 1
        artifactReadGeneration += 1
        artifacts = []
        artifactListBusy = false
        hasEarlierArtifacts = false
        nextBeforeArtifactSequence = nil
        selectedArtifactID = nil
        artifactText = ""
        artifactEndByte = 0
        artifactHasLater = false
        artifactBusy = false
        artifactNotice = nil
        loadArtifactPage()
    }

    func loadEarlierArtifacts() {
        guard hasEarlierArtifacts else { return }
        loadArtifactPage()
    }

    private func loadArtifactPage() {
        guard let client, let threadID = selectedThreadID, !artifactListBusy else { return }
        let generation = artifactGeneration
        let before = nextBeforeArtifactSequence
        artifactListBusy = true
        Task {
            do {
                let page = try await client.listArtifacts(threadID: threadID, beforeSequence: before)
                guard self.client === client, selectedThreadID == threadID,
                      artifactGeneration == generation else { return }
                artifacts.append(contentsOf: page.artifacts)
                hasEarlierArtifacts = page.hasEarlier
                nextBeforeArtifactSequence = page.nextBeforeSequence
                artifactNotice = nil
            } catch {
                guard self.client === client, selectedThreadID == threadID,
                      artifactGeneration == generation else { return }
                artifactNotice = "无法读取远程产物：\(error.localizedDescription)"
            }
            guard self.client === client, selectedThreadID == threadID,
                  artifactGeneration == generation else { return }
            artifactListBusy = false
        }
    }

    func openArtifact(_ id: String) {
        artifactReadGeneration += 1
        selectedArtifactID = id
        artifactText = ""
        artifactEndByte = 0
        artifactHasLater = false
        artifactBusy = false
        artifactNotice = nil
        guard let descriptor = artifacts.first(where: { $0.id == id }) else { return }
        guard descriptor.artifact.mediaType == "text/plain; charset=utf-8" ||
              descriptor.artifact.mediaType == "application/json" else {
            artifactNotice = "此产物不是可预览的文本或 JSON。"
            return
        }
        loadMoreArtifact()
    }

    func loadMoreArtifact() {
        guard let client, let threadID = selectedThreadID,
              let id = selectedArtifactID, !artifactBusy else { return }
        let generation = artifactReadGeneration
        let after = artifactEndByte
        artifactBusy = true
        Task {
            do {
                let range = try await client.readArtifact(
                    threadID: threadID, artifactID: id, afterByte: after
                )
                guard self.client === client, selectedThreadID == threadID,
                      selectedArtifactID == id, artifactReadGeneration == generation else { return }
                guard range.artifact.id == id, range.startByte == after,
                      range.endByte > after || !range.hasLater else {
                    throw RemoteError(message: "远程产物分页响应无效。")
                }
                artifactText += range.content
                artifactEndByte = range.endByte
                artifactHasLater = range.hasLater
                artifactNotice = nil
            } catch {
                guard self.client === client, selectedThreadID == threadID,
                      selectedArtifactID == id, artifactReadGeneration == generation else { return }
                artifactNotice = "无法读取产物内容：\(error.localizedDescription)"
            }
            guard self.client === client, selectedThreadID == threadID,
                  selectedArtifactID == id, artifactReadGeneration == generation else { return }
            artifactBusy = false
        }
    }

    private func resetArtifacts() {
        artifactGeneration += 1
        artifactReadGeneration += 1
        artifacts = []
        artifactListBusy = false
        hasEarlierArtifacts = false
        nextBeforeArtifactSequence = nil
        selectedArtifactID = nil
        artifactText = ""
        artifactEndByte = 0
        artifactHasLater = false
        artifactBusy = false
        artifactNotice = nil
    }

    func startTurn() {
        guard canSend, let workspaceID = selectedWorkspaceID, let client else { return }
        let effects = (allowWrites ? ["workspace:mutate"] : []) +
            (allowCommands ? ["process:control"] : []) +
            (allowMcp ? ["mcp:invoke"] : [])
        let request = PendingRemoteStart(
            origin: client.settings.origin,
            certificateSha256: client.settings.certificateSha256,
            workspaceID: workspaceID,
            prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines),
            requestID: UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased(),
            resumeThreadID: selectedThreadID,
            effects: effects.isEmpty ? nil : effects
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
                    resumeThreadID: pendingStart.resumeThreadID,
                    effects: pendingStart.effects
                )
                guard self.client === client else { return }
                if result.status == "reserved" {
                    notice = "请求已预留但启动结果未确认，请稍后重试同一请求。"
                    return
                }
                if result.status == "abandoned" {
                    try RemoteSettingsStore.deletePendingStart()
                    self.pendingStart = nil
                    hasPendingStart = false
                    notice = "主机所有者已放弃这次未启动的请求。可以重新发送并生成新请求 ID。"
                    return
                }
                guard result.status == "started" else {
                    throw RemoteError(message: "远程请求状态无效。")
                }
                try RemoteSettingsStore.deletePendingStart()
                self.pendingStart = nil
                hasPendingStart = false
                prompt = ""
                allowWrites = false
                allowCommands = false
                allowMcp = false
                notice = nil
                if let previous = activeTurns.updateValue(result.turnId, forKey: result.threadId) {
                    stopPendingTurns.remove(previous)
                }
                stopPendingTurns.remove(result.turnId)
                selectThread(result.threadId)
                refreshThreads()
            } catch {
                guard self.client === client else { return }
                notice = "请求结果未确认，请重试同一请求：\(error.localizedDescription)"
            }
        }
    }

    func cancelTurn() {
        guard canCancel, let client, let threadID = selectedThreadID,
              let turnID = activeTurns[threadID] else { return }
        stopPendingTurns.insert(turnID)
        Task {
            do {
                try await client.cancelTurn(threadID: threadID, turnID: turnID)
                guard self.client === client,
                      activeTurns[threadID] == turnID else { return }
                notice = "已请求停止，等待主机确认。"
            } catch {
                guard self.client === client,
                      activeTurns[threadID] == turnID else { return }
                stopPendingTurns.remove(turnID)
                notice = "停止结果未确认，请查看 Thread 更新：\(error.localizedDescription)"
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
                let socket = try client.subscribe(threadID: threadID, after: cursor, activity: true)
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
            if let index = entries.indices.last,
               entries[index].turnID == update.turnId, !entries[index].isActivity {
                entries[index].text += update.text ?? ""
            } else {
                entries.append(RemoteChatEntry(
                    id: "assistant-\(update.sequence)", text: update.text ?? "",
                    turnID: update.turnId
                ))
            }
        case "turn.failed":
            if activeTurns[threadID] == update.turnId {
                activeTurns.removeValue(forKey: threadID)
                stopPendingTurns.remove(update.turnId)
            }
            entries.append(RemoteChatEntry(
                id: "failure-\(update.sequence)",
                text: "Turn 失败：\(update.code ?? "未知错误")",
                isActivity: true
            ))
            refreshThreads()
        case "turn.completed", "turn.cancelled":
            if activeTurns[threadID] == update.turnId {
                activeTurns.removeValue(forKey: threadID)
                stopPendingTurns.remove(update.turnId)
            }
            entries.append(RemoteChatEntry(
                id: "activity-\(update.sequence)",
                text: update.type == "turn.completed" ? "Turn 已完成" : "Turn 已取消",
                isActivity: true
            ))
            refreshThreads()
        default:
            entries.append(RemoteChatEntry(
                id: "activity-\(update.sequence)",
                text: activityText(update),
                isActivity: true
            ))
        }
        if update.type == "approval.requested" || update.type == "approval.resolved" {
            refreshApprovals()
            if update.type == "approval.requested" {
                Task {
                    try? await Task.sleep(nanoseconds: 250_000_000)
                    if selectedThreadID == threadID { refreshApprovals() }
                }
            }
        }
    }

    private func activityText(_ update: RemoteUpdate) -> String {
        switch update.type {
        case "turn.started": return "Turn 已开始"
        case "turn.context", "context.prepared": return "上下文已准备"
        case "tool.catalog_changed": return "工具目录已更新"
        case "model.usage": return "模型第 \(update.step ?? 0) 步用量已记录"
        case "item.recorded": return "消息已记录：\(update.itemType ?? "未知类型")"
        case "artifact.recorded": return "产物已记录"
        case "tool.started": return "工具调用已开始"
        case "tool.execution_started": return "工具执行已开始：\(update.effect ?? "未知效果")"
        case "tool.completed": return "工具调用已结束：\(update.status ?? "未知状态")"
        case "process.started": return "命令进程已开始"
        case "process.exited": return "命令进程已退出：\(update.exitCode.map(String.init) ?? "无退出码")"
        case "process.termination_requested": return "命令终止已请求"
        case "process.termination_completed": return "命令终止已完成：\(update.outcome ?? "未知结果")"
        case "workspace.change_set_prepared": return "工作区变更已准备"
        case "workspace.change_set_committed": return "工作区变更已提交"
        case "workspace.change_set_rolled_back": return "工作区变更已回滚"
        case "workspace.change_set_uncertain": return "工作区变更结果待确认"
        case "workspace.change_set_resolved": return "工作区变更结果已确认"
        case "approval.requested": return "审批请求已记录"
        case "approval.resolved": return "审批已处理：\(update.decision ?? "未知结果")"
        case "approval.grant_created", "approval.grant_used": return "审批授权状态已更新"
        case "plan.updated", "plan.checkpointed": return "计划已更新"
        case "plan.acceptance_requested": return "计划验收已请求"
        case "plan.acceptance_resolved": return "计划验收已处理"
        case "turn.paused": return "Turn 已暂停"
        default: return "事件：\(update.type)"
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
        resetArtifacts()
        client?.close()
        client = nil
        connected = false
        workspaces = []
        selectedWorkspaceID = nil
        threads = []
        selectedThreadID = nil
        entries = []
        activeTurns = [:]
        stopPendingTurns = []
        approvalGeneration += 1
        approvals = []
        selectedApproval = nil
        approvalBusy = false
    }
}
