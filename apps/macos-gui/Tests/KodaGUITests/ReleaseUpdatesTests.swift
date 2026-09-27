import Foundation
import XCTest
@testable import KodaGUI

final class ReleaseUpdatesTests: XCTestCase {
    func testSelectsOnlyNewerMacAppReleaseForArchitecture() throws {
        let releases = [
            release("v0.3.0", draft: true, assets: ["Koda-v0.3.0-darwin-arm64.pkg", "Koda-v0.3.0-darwin-arm64.update.json"]),
            release("v0.2.0", assets: ["koda-v0.2.0-darwin-arm64.zip"]),
            release("v0.1.2", assets: ["Koda-v0.1.2-darwin-x64.pkg", "Koda-v0.1.2-darwin-x64.update.json"]),
            release("v0.1.1", assets: ["Koda-v0.1.1-darwin-arm64.pkg"]),
            release("v0.1.0", assets: ["Koda-v0.1.0-darwin-arm64.pkg", "Koda-v0.1.0-darwin-arm64.update.json"]),
            release("v0.1.1-rc.2", assets: ["Koda-v0.1.1-rc.2-darwin-arm64.pkg", "Koda-v0.1.1-rc.2-darwin-arm64.update.json"]),
        ]
        let data = try JSONSerialization.data(withJSONObject: releases)
        let candidate = try ReleaseUpdates.select(from: data, installedVersion: "0.1.0",
                                                   architecture: "arm64")
        XCTAssertEqual(candidate?.version, "0.1.1-rc.2")
        XCTAssertEqual(candidate?.page.absoluteString,
                       "https://github.com/ronaldo123321/koda/releases/tag/v0.1.1-rc.2")
        XCTAssertNil(try ReleaseUpdates.select(from: data, installedVersion: "0.2.0",
                                               architecture: "arm64"))
    }

    func testRejectsAssetDownloadOutsideTheProjectRelease() throws {
        var spoofed = release("v9.0.0", assets: [
            "Koda-v9.0.0-darwin-arm64.pkg", "Koda-v9.0.0-darwin-arm64.update.json",
        ])
        var assets = try XCTUnwrap(spoofed["assets"] as? [[String: String]])
        assets[0]["browser_download_url"] = "https://example.com/Koda-v9.0.0-darwin-arm64.pkg"
        spoofed["assets"] = assets
        let data = try JSONSerialization.data(withJSONObject: [spoofed])
        XCTAssertNil(try ReleaseUpdates.select(from: data, installedVersion: "0.1.0",
                                               architecture: "arm64"))
    }

    private func release(_ tag: String, draft: Bool = false, assets: [String]) -> [String: Any] {
        [
            "tag_name": tag,
            "html_url": "https://github.com/ronaldo123321/koda/releases/tag/\(tag)",
            "draft": draft,
            "assets": assets.map { [
                "name": $0,
                "state": "uploaded",
                "browser_download_url": "https://github.com/ronaldo123321/koda/releases/download/\(tag)/\($0)",
            ] },
        ]
    }
}
