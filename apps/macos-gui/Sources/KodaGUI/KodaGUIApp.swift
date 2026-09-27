import SwiftUI

@main
struct KodaGUIApp: App {
    var body: some Scene {
        WindowGroup("Koda") {
            ContentView()
                .frame(minWidth: 780, minHeight: 560)
        }
        WindowGroup("远程连接", id: "remote") {
            RemoteContentView()
                .frame(minWidth: 780, minHeight: 560)
        }
    }
}
