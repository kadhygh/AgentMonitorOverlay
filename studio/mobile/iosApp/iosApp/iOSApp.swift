import SwiftUI
import Shared

// The whole app is the shared Compose UI (shared/src/iosMain/MainViewController.kt); Swift only hosts it.
@main
struct iOSApp: App {
    var body: some Scene {
        WindowGroup { ComposeView().ignoresSafeArea() }
    }
}

struct ComposeView: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> UIViewController { MainViewControllerKt.MainViewController() }
    func updateUIViewController(_ controller: UIViewController, context: Context) {}
}
