import SwiftUI

@main
struct OMPMobileBarApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        MenuBarExtra {
            MenuContentView(model: model)
        } label: {
            Label {
                Text("OMP Mobile")
            } icon: {
                Image(nsImage: model.serverState.menuBarMark.image)
            }
        }
        .menuBarExtraStyle(.window)
    }
}
