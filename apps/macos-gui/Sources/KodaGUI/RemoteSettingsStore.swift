import Foundation
import Security

enum RemoteSettingsStore {
    private static let service = "com.koda.gui.preview.remote"

    static func load() throws -> RemoteSettings? {
        guard let data = try loadData(account: "primary") else { return nil }
        return try JSONDecoder().decode(RemoteSettings.self, from: data)
    }

    static func save(_ settings: RemoteSettings) throws {
        try saveData(JSONEncoder().encode(settings), account: "primary")
    }

    static func delete() throws { try delete(account: "primary") }

    static func loadPendingStart() throws -> PendingRemoteStart? {
        guard let data = try loadData(account: "pending-start") else { return nil }
        return try JSONDecoder().decode(PendingRemoteStart.self, from: data)
    }

    static func savePendingStart(_ request: PendingRemoteStart) throws {
        try saveData(JSONEncoder().encode(request), account: "pending-start")
    }

    static func deletePendingStart() throws { try delete(account: "pending-start") }

    private static func loadData(account: String) throws -> Data? {
        var result: CFTypeRef?
        let status = SecItemCopyMatching([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ] as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw KeychainError(status: status)
        }
        return data
    }

    private static func saveData(_ data: Data, account: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw KeychainError(status: status) }
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let addStatus = SecItemAdd(item as CFDictionary, nil)
        guard addStatus == errSecSuccess else { throw KeychainError(status: addStatus) }
    }

    private static func delete(account: String) throws {
        let status = SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ] as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError(status: status)
        }
    }
}
