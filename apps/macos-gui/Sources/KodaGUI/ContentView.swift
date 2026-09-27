import AppKit
import SwiftUI

struct ContentView: View {
    @Environment(\.openWindow) private var openWindow
    @StateObject private var model = KodaModel()
    @State private var credentialProvider: ProviderOption?
    @State private var checkingUpdates = false
    @State private var downloadingUpdate = false
    @State private var updateNotice: String?
    @State private var updateCandidate: ReleaseUpdate?
    @State private var downloadedUpdateURL: URL?

    var body: some View {
        NavigationSplitView {
            VStack(spacing: 0) {
                HStack {
                    Button("新对话", systemImage: "square.and.pencil") {
                        model.selectThread(nil)
                    }
                    Spacer()
                    Button("刷新", systemImage: "arrow.clockwise") {
                        model.refreshThreads()
                    }
                    .labelStyle(.iconOnly)
                }
                .padding(12)
                if model.threads.isEmpty {
                    Text(model.workspace == nil ? "请选择工作区" : "暂无历史对话")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    List(selection: $model.selectedThreadID) {
                        ForEach(model.threads) { thread in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(thread.id)
                                    .font(.system(.body, design: .monospaced))
                                    .lineLimit(1)
                                Text(thread.status)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .tag(thread.id)
                        }
                    }
                }
            }
            .navigationTitle("Thread")
            .navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 320)
        } detail: {
            VStack(spacing: 0) {
                header
                Divider()
                transcript
                Divider()
                composer
            }
            .navigationTitle("Koda")
        }
        .onAppear { model.connect() }
        .onChange(of: model.selectedThreadID) { _, id in model.selectThread(id) }
        .sheet(item: $model.approval) { request in
            ApprovalView(request: request) { approved in
                model.resolveApproval(approved: approved)
            }
            .interactiveDismissDisabled(true)
        }
        .sheet(item: $credentialProvider) { provider in
            CredentialView(
                provider: provider,
                stored: model.storedCredentialNames.contains(provider.credentialName),
                save: { value in model.saveCredential(value, for: provider) },
                delete: { model.deleteCredential(for: provider) }
            )
        }
    }

    private func checkForUpdates() {
        guard let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString")
                as? String else {
            updateNotice = "无法读取当前应用版本。"
            return
        }
        checkingUpdates = true
        updateNotice = nil
        updateCandidate = nil
        downloadedUpdateURL = nil
        Task {
            do {
                if let candidate = try await ReleaseUpdates.check(installedVersion: version) {
                    updateNotice = "发现 macOS 应用候选版本 v\(candidate.version)。"
                    updateCandidate = candidate
                } else {
                    updateNotice = "GitHub Releases 暂无适用于此 Mac 的较新应用版本。"
                }
            } catch {
                updateNotice = "检查更新失败：\(error.localizedDescription)"
            }
            checkingUpdates = false
        }
    }

    private func downloadUpdate() {
        guard let candidate = updateCandidate else { return }
        downloadingUpdate = true
        updateNotice = "正在下载并验证更新包…"
        Task {
            do {
                downloadedUpdateURL = try await ReleaseUpdates.download(candidate)
                updateNotice = "更新包已通过摘要验证；应用内安装尚未开放。"
            } catch {
                updateNotice = "更新包下载或验证失败：\(error.localizedDescription)"
            }
            downloadingUpdate = false
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Button {
                    let panel = NSOpenPanel()
                    panel.canChooseFiles = false
                    panel.canChooseDirectories = true
                    panel.allowsMultipleSelection = false
                    if panel.runModal() == .OK, let url = panel.url {
                        model.useWorkspace(url)
                    }
                } label: {
                    Label(model.workspace?.lastPathComponent ?? "选择工作区", systemImage: "folder")
                }
                .help(model.workspace?.path ?? "选择要使用的代码目录")
                Spacer()
                Circle()
                    .fill(model.connected ? .green : .orange)
                    .frame(width: 8, height: 8)
                Text(model.connected ? "已连接" : "未连接")
                    .font(.caption)
                if !model.connected {
                    Button("重连") { model.reconnect() }
                }
                Button("远程…") { openWindow(id: "remote") }
                Button(checkingUpdates ? "检查中…" : "检查更新") { checkForUpdates() }
                    .disabled(checkingUpdates || downloadingUpdate)
            }
            if let updateNotice {
                HStack {
                    Text(updateNotice)
                    if let updateCandidate {
                        Link("查看 Release", destination: updateCandidate.page)
                        if downloadedUpdateURL == nil {
                            Button(downloadingUpdate ? "下载中…" : "下载并验证") {
                                downloadUpdate()
                            }
                            .disabled(downloadingUpdate)
                        }
                    }
                }
                .font(.caption)
            }
            if let downloadedUpdateURL {
                Text(downloadedUpdateURL.path)
                    .font(.caption)
                    .textSelection(.enabled)
            }
            HStack {
                Picker("Provider", selection: Binding(
                    get: { model.selectedProviderID },
                    set: { model.chooseProvider($0) }
                )) {
                    ForEach(model.providers) { provider in
                        Text(provider.name).tag(provider.id)
                    }
                }
                .frame(maxWidth: 210)
                TextField("模型", text: $model.modelName)
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 260)
                Button("凭据…") { credentialProvider = model.selectedProvider }
                    .disabled(model.selectedProvider == nil || model.activeTurnID != nil)
                Spacer()
                if let turnID = model.activeTurnID {
                    Button("停止", systemImage: "stop.fill") { model.cancelTurn() }
                        .help("取消 Turn \(turnID)")
                }
            }
            if let provider = model.selectedProvider, !provider.configured {
                Text("缺少 \(provider.credentialName)。请配置凭据。")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
            if let notice = model.notice {
                Text(notice)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }
        }
        .padding()
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if model.entries.isEmpty && model.streamingText.isEmpty {
                        ContentUnavailableView(
                            model.workspace == nil ? "选择工作区" : "开始对话",
                            systemImage: "bubble.left.and.text.bubble.right",
                            description: Text(model.workspace == nil
                                ? "选择代码目录后即可查看历史对话。"
                                : "输入问题，Koda 会在此显示回复。")
                        )
                        .frame(maxWidth: .infinity, minHeight: 260)
                    }
                    ForEach(model.entries) { entry in
                        ChatBubble(entry: entry).id(entry.id)
                    }
                    if !model.streamingText.isEmpty {
                        ChatBubble(entry: ChatEntry(
                            id: "streaming", role: "assistant", text: model.streamingText
                        ))
                        .id("streaming")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(20)
            }
            .onChange(of: model.entries.count) { _, _ in
                if let id = model.entries.last?.id { proxy.scrollTo(id, anchor: .bottom) }
            }
            .onChange(of: model.streamingText) { _, value in
                if !value.isEmpty { proxy.scrollTo("streaming", anchor: .bottom) }
            }
        }
    }

    private var composer: some View {
        VStack(alignment: .trailing, spacing: 8) {
            TextEditor(text: $model.prompt)
                .font(.body)
                .frame(minHeight: 64, maxHeight: 110)
                .scrollContentBackground(.hidden)
                .padding(6)
                .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 9))
            Button("发送", systemImage: "arrow.up") { model.startTurn() }
                .buttonStyle(.borderedProminent)
                .disabled(!model.canSend)
                .keyboardShortcut(.return, modifiers: [.command])
        }
        .padding()
    }
}

private struct CredentialView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var key = ""
    let provider: ProviderOption
    let stored: Bool
    let save: (String) -> Bool
    let delete: () -> Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("\(provider.name) 凭据").font(.title2.weight(.semibold))
            Text("密钥保存在本机 Keychain，只传给本机 app-server 进程。")
                .foregroundStyle(.secondary)
            SecureField(provider.credentialName, text: $key)
                .textFieldStyle(.roundedBorder)
            HStack {
                if stored {
                    Button("删除已存凭据", role: .destructive) {
                        if delete() { dismiss() }
                    }
                }
                Spacer()
                Button("取消") { dismiss() }
                Button("保存") {
                    if save(key) { key = ""; dismiss() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(24)
        .frame(minWidth: 460)
    }
}

private struct ChatBubble: View {
    let entry: ChatEntry

    var body: some View {
        HStack {
            if entry.role == "user" { Spacer(minLength: 80) }
            VStack(alignment: .leading, spacing: 6) {
                Text(entry.role == "user" ? "你" : "Koda")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(entry.text)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(12)
            .frame(maxWidth: 650, alignment: .leading)
            .background(
                entry.role == "user" ? Color.accentColor.opacity(0.12) : Color.secondary.opacity(0.08),
                in: RoundedRectangle(cornerRadius: 12)
            )
            if entry.role != "user" { Spacer(minLength: 80) }
        }
    }
}

private struct ApprovalView: View {
    let request: ApprovalRequest
    let decide: (Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(request.title).font(.title2.weight(.semibold))
            Text(request.summary)
            if !request.reason.isEmpty {
                Text(request.reason).foregroundStyle(.secondary)
            }
            ScrollView {
                Text(request.details)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(minHeight: 100, maxHeight: 320)
            HStack {
                Spacer()
                Button("拒绝") { decide(false) }
                Button("批准") { decide(true) }
                    .buttonStyle(.borderedProminent)
            }
        }
        .padding(24)
        .frame(minWidth: 540)
    }
}
