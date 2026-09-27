import SwiftUI

struct RemoteContentView: View {
    @StateObject private var model = RemoteModel()
    @State private var showingConnection = false

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
                    Text(model.connected ? "暂无可见 Thread" : "请连接远程主机")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    List(selection: Binding(
                        get: { model.selectedThreadID },
                        set: { model.selectThread($0) }
                    )) {
                        ForEach(model.threads) { thread in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(thread.threadId)
                                    .font(.system(.body, design: .monospaced))
                                    .lineLimit(1)
                                Text(thread.status)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .tag(thread.threadId)
                        }
                    }
                }
            }
            .navigationTitle("远程 Thread")
            .navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 320)
        } detail: {
            VStack(spacing: 0) {
                header
                Divider()
                transcript
                Divider()
                composer
            }
            .navigationTitle("Koda 远程")
        }
        .onAppear {
            model.connectSaved()
            if !model.hasSavedConnection { showingConnection = true }
        }
        .onChange(of: model.connected) { _, connected in
            if connected { showingConnection = false }
        }
        .sheet(isPresented: $showingConnection) {
            RemoteConnectionView(model: model)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(model.endpoint.isEmpty ? "未配置远程主机" : model.endpoint)
                    .lineLimit(1)
                    .textSelection(.enabled)
                Spacer()
                Circle()
                    .fill(model.connected ? .green : .orange)
                    .frame(width: 8, height: 8)
                Text(model.connected ? "已连接" : "未连接")
                    .font(.caption)
                if !model.connected && model.hasSavedConnection {
                    Button("重连") { model.reconnect() }
                }
                Button("连接设置…") { showingConnection = true }
            }
            HStack {
                Picker("工作区", selection: Binding(
                    get: { model.selectedWorkspaceID ?? "" },
                    set: { model.selectWorkspace($0) }
                )) {
                    ForEach(model.workspaces, id: \.self) { id in
                        Text(id).tag(id)
                    }
                }
                .frame(maxWidth: 300)
                .disabled(!model.connected)
                Spacer()
            }
            Text("远程预览当前只显示助手文本和 Turn 状态；工具、文件与审批内容不会传输。")
                .font(.caption)
                .foregroundStyle(.secondary)
            if let notice = model.notice {
                Text(notice)
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .textSelection(.enabled)
            }
        }
        .padding()
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if model.entries.isEmpty {
                        ContentUnavailableView(
                            model.selectedThreadID == nil ? "选择或发起远程对话" : "暂无助手更新",
                            systemImage: "network",
                            description: Text("远程主机仅投射已授权的助手更新。")
                        )
                        .frame(maxWidth: .infinity, minHeight: 260)
                    }
                    ForEach(model.entries) { entry in
                        Text(entry.text)
                            .textSelection(.enabled)
                            .frame(maxWidth: 680, alignment: .leading)
                            .padding(12)
                            .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .id(entry.id)
                    }
                }
                .padding(20)
            }
            .onChange(of: model.entries.count) { _, _ in
                if let id = model.entries.last?.id { proxy.scrollTo(id, anchor: .bottom) }
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
            HStack {
                if model.hasPendingStart {
                    Button("重试同一请求") { model.retryStart() }
                        .disabled(model.startRetrying || !model.connected)
                    Button("放弃重试") { model.abandonPendingStart() }
                        .disabled(model.startRetrying)
                }
                if model.canCancel {
                    Button("停止", systemImage: "stop.fill") { model.cancelTurn() }
                }
                Spacer()
                Button("发送", systemImage: "arrow.up") { model.startTurn() }
                    .buttonStyle(.borderedProminent)
                    .disabled(!model.canSend)
                    .keyboardShortcut(.return, modifiers: [.command])
            }
        }
        .padding()
    }
}

private struct RemoteConnectionView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var model: RemoteModel
    @State private var origin = ""
    @State private var fingerprint = ""
    @State private var token = ""
    @State private var confirmingForget = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("连接个人主机").font(.title2.weight(.semibold))
            Text("在主机执行 koda remote serve，并核对其输出的证书 SHA-256 指纹。设备令牌由主机本地签发。")
                .foregroundStyle(.secondary)
            TextField("https://192.168.1.10:8443", text: $origin)
                .textFieldStyle(.roundedBorder)
            TextField("证书 SHA-256 指纹（64 位十六进制）", text: $fingerprint)
                .textFieldStyle(.roundedBorder)
            SecureField("设备令牌", text: $token)
                .textFieldStyle(.roundedBorder)
            Text("首次连接通过证书与设备授权验证后，配置才会保存到这台 Mac 的 Keychain。")
                .font(.caption)
                .foregroundStyle(.secondary)
            if let notice = model.notice {
                Text(notice).foregroundStyle(.orange).textSelection(.enabled)
            }
            HStack {
                if model.hasSavedConnection {
                    Button("忘记已存连接", role: .destructive) {
                        confirmingForget = true
                    }
                }
                Spacer()
                Button("取消") { dismiss() }
                Button(model.connecting ? "连接中…" : "验证并保存") {
                    model.connect(RemoteSettings(
                        origin: origin.trimmingCharacters(in: .whitespacesAndNewlines),
                        certificateSha256: fingerprint.trimmingCharacters(in: .whitespacesAndNewlines),
                        token: token.trimmingCharacters(in: .whitespacesAndNewlines)
                    ), save: true)
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.connecting || origin.isEmpty || fingerprint.isEmpty || token.isEmpty)
            }
        }
        .padding(24)
        .frame(minWidth: 560)
        .onAppear { origin = model.endpoint }
        .confirmationDialog("删除这台 Mac 保存的远程设备令牌？", isPresented: $confirmingForget) {
            Button("删除本机凭据", role: .destructive) {
                model.forgetConnection()
                dismiss()
            }
        }
    }
}
