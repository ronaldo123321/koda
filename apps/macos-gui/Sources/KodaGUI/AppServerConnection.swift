import Foundation

final class AppServerConnection {
    typealias Reply = (Result<[String: Any], Error>) -> Void

    var onNotification: ((String, [String: Any]) -> Void)?
    var onDisconnect: (() -> Void)?

    private let process = Process()
    private let input = Pipe()
    private let output = Pipe()
    private let errors = Pipe()
    private let queue = DispatchQueue(label: "koda.gui.app-server")
    private var buffer = Data()
    private var nextID = 1
    private var pending: [Int: Reply] = [:]
    private var stopped = false
    private let maximumLineBytes = 2_359_296

    init(kodaPath: String?, credentials: [String: String]) throws {
        if let kodaPath {
            process.executableURL = URL(fileURLWithPath: kodaPath)
            process.arguments = ["app-server"]
        } else {
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = ["koda", "app-server"]
        }
        process.standardInput = input
        process.standardOutput = output
        process.standardError = errors
        process.environment = ProcessInfo.processInfo.environment.merging(credentials) { _, stored in stored }
        try process.run()
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            self?.queue.async { [weak self] in self?.receive(data) }
        }
        errors.fileHandleForReading.readabilityHandler = { handle in
            _ = handle.availableData
        }
        process.terminationHandler = { [weak self] _ in
            self?.queue.async { [weak self] in self?.failAll("app-server 已退出。") }
        }
    }

    func request(_ method: String, params: [String: Any], reply: @escaping Reply) {
        queue.async {
            guard !self.stopped else {
                DispatchQueue.main.async { reply(.failure(ConnectionError("连接已关闭。"))) }
                return
            }
            let id = self.nextID
            self.nextID += 1
            let message: [String: Any] = [
                "jsonrpc": "2.0", "id": id, "method": method, "params": params,
            ]
            do {
                var data = try JSONSerialization.data(withJSONObject: message)
                data.append(0x0A)
                self.pending[id] = reply
                self.input.fileHandleForWriting.write(data)
                let timeout = method == "turn/start" ? 30.0 : 10.0
                self.queue.asyncAfter(deadline: .now() + timeout) {
                    guard let expired = self.pending.removeValue(forKey: id) else { return }
                    DispatchQueue.main.async {
                        expired(.failure(ConnectionError("app-server 请求超时。")))
                    }
                }
            } catch {
                self.pending.removeValue(forKey: id)
                DispatchQueue.main.async { reply(.failure(error)) }
            }
        }
    }

    func stop() {
        output.fileHandleForReading.readabilityHandler = nil
        errors.fileHandleForReading.readabilityHandler = nil
        queue.async { self.failAll("连接已关闭。") }
        if process.isRunning { process.terminate() }
    }

    private func receive(_ data: Data) {
        guard !stopped else { return }
        if data.isEmpty {
            failAll("app-server 已断开。")
            return
        }
        buffer.append(data)
        while let newline = buffer.firstIndex(of: 0x0A) {
            guard newline <= maximumLineBytes else {
                failAll("app-server 消息过大。")
                return
            }
            let line = buffer.prefix(upTo: newline)
            buffer.removeSubrange(...newline)
            guard
                let value = try? JSONSerialization.jsonObject(with: Data(line)),
                let message = value as? [String: Any]
            else {
                failAll("app-server 返回了无效消息。")
                return
            }
            if let id = message["id"] as? Int {
                guard let reply = pending.removeValue(forKey: id) else { continue }
                let result: Result<[String: Any], Error>
                if let body = message["result"] as? [String: Any] {
                    result = .success(body)
                } else if let error = message["error"] as? [String: Any] {
                    let detail = String((error["message"] as? String ?? "请求失败。").prefix(500))
                    result = .failure(ConnectionError(detail))
                } else {
                    result = .failure(ConnectionError("app-server 响应格式错误。"))
                }
                DispatchQueue.main.async { reply(result) }
            } else if
                let method = message["method"] as? String,
                let params = message["params"] as? [String: Any]
            {
                DispatchQueue.main.async { [weak self] in
                    self?.onNotification?(method, params)
                }
            }
        }
        if buffer.count > maximumLineBytes { failAll("app-server 消息过大。") }
    }

    private func failAll(_ message: String) {
        guard !stopped else { return }
        stopped = true
        let replies = Array(pending.values)
        pending.removeAll()
        DispatchQueue.main.async { [weak self] in
            for reply in replies { reply(.failure(ConnectionError(message))) }
            self?.onDisconnect?()
        }
    }
}

struct ConnectionError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
