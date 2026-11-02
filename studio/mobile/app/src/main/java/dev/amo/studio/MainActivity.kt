package dev.amo.studio

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.*
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.core.view.WindowCompat

class MainActivity : ComponentActivity() {
    private lateinit var repository: StudioRepository
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        @Suppress("DEPRECATION")
        val retained = lastCustomNonConfigurationInstance as? StudioRepository
        repository = retained ?: StudioRepository(applicationContext)
        setContent {
            val state by repository.state.collectAsState()
            val dark = state.theme == "dark" || state.theme == "system" && isSystemInDarkTheme()
            SideEffect { WindowCompat.getInsetsController(window, window.decorView).apply { isAppearanceLightStatusBars = !dark; isAppearanceLightNavigationBars = !dark } }
            AmoTheme(state.theme) { StudioUi(state, repository) }
        }
    }
    override fun onResume() { super.onResume(); if (::repository.isInitialized) repository.refresh() }
    override fun onStop() { if (::repository.isInitialized) repository.persist(); super.onStop() }
    @Deprecated("Activity retention is used to keep the connection and selected session during rotation")
    override fun onRetainCustomNonConfigurationInstance(): Any = repository
    override fun onDestroy() { if (::repository.isInitialized && !isChangingConfigurations) repository.close(); super.onDestroy() }
}
