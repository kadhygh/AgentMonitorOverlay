package dev.amo.studio

import androidx.compose.runtime.*
import androidx.compose.ui.window.ComposeUIViewController
import platform.Foundation.NSNotificationCenter
import platform.Foundation.NSOperationQueue
import platform.UIKit.UIApplicationDidBecomeActiveNotification
import platform.UIKit.UIApplicationDidEnterBackgroundNotification
import platform.UIKit.UIViewController

/**
 * The app's screen for iosApp (Swift calls `MainViewControllerKt.MainViewController()`), as MainActivity is on Android:
 * one StudioRepository for the app's life; refresh when the app comes back, save histories when it goes away.
 */
fun MainViewController(): UIViewController {
    val repository = StudioRepository(IosPlatform())
    val center = NSNotificationCenter.defaultCenter
    center.addObserverForName(UIApplicationDidBecomeActiveNotification, null, NSOperationQueue.mainQueue) { _ -> repository.refresh() }
    center.addObserverForName(UIApplicationDidEnterBackgroundNotification, null, NSOperationQueue.mainQueue) { _ -> repository.persist() }
    return ComposeUIViewController {
        val state by repository.state.collectAsState()
        AmoTheme(state.theme) { StudioUi(state, repository) }
    }
}
