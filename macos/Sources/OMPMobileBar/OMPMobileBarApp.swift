import SwiftUI

@main
struct OMPMobileBarApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        MenuBarExtra {
            MenuContentView(model: model)
        } label: {
            Label("OMP Mobile", systemImage: model.serverState.symbolName)
        }
        .menuBarExtraStyle(.window)
    }
}
