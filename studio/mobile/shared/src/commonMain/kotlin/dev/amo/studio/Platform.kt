package dev.amo.studio

import io.ktor.client.HttpClient
import okio.FileSystem
import okio.Path

// What the shared code needs from the phone it runs on (2026-11-02, plans/ios.md 第 2 步): Android implements it in
// AndroidPlatform.kt, iOS in iosMain. Everything else in StudioRepository is the same on both.
interface Platform {
    /** The installed build: Android's versionCode/versionName, iOS's CFBundleVersion/CFBundleShortVersionString. */
    val versionCode: Long
    val versionName: String
    /** What the computer and the pairing list call this phone. */
    val deviceName: String
    val fileSystem: FileSystem
    /** The app's own files (the phone's copy of histories lives under remote-cache/). */
    val filesDir: Path
    val prefs: Prefs
    /** The client for the team server: HTTP and the devices WebSocket, with the platform's engine and timeouts. */
    fun httpClient(): HttpClient
    /** The account key at rest, with a key that never leaves the phone's keystore (Android Keystore, iOS Keychain). */
    fun encrypt(text: String): String
    fun decrypt(text: String): String
    /** Updating the app by itself from the team server; null where the store does it (iOS: TestFlight). */
    val updater: Updater?
}

/** Small settings: Android's SharedPreferences, iOS's NSUserDefaults. Never the account key in clear. */
interface Prefs {
    fun string(key: String): String?
    fun boolean(key: String, fallback: Boolean): Boolean
    fun put(key: String, value: String)
    fun put(key: String, value: Boolean)
    fun remove(vararg keys: String)
}

/** Android's self-update (AppUpdate.kt): the server's newest build, its download, the system installer. */
interface Updater {
    /** The server's newest build, or null when it has none published. */
    suspend fun latest(account: Account): AndroidLatest?
    /** Downloads and checks `latest`; the path of the file ready to install. `progress` gets the bytes so far. */
    suspend fun download(account: Account, latest: AndroidLatest, progress: (Long) -> Unit): String
    /** Drops what was downloaded before. */
    suspend fun forget()
    /** Whether the system lets this app install apps now (else the installer first asks the person to allow it). */
    fun canInstall(): Boolean
    fun openInstaller(path: String)
}

/** The newest build on the team server (its android/latest.json). */
data class AndroidLatest(val version: String, val versionCode: Int, val file: String, val size: Long, val sha256: String, val notes: String)

data class AppUpdate(
    val checking: Boolean = false,
    /** A build newer than this app; null when there is none (or not checked yet). */
    val latest: AndroidLatest? = null,
    val checkedAt: Long = 0,
    /** What the last check said when there is nothing to offer (已是最新, not published, why it failed). */
    val note: String? = null,
    val downloading: Boolean = false,
    val downloaded: Long = 0,
    /** The checked APK's path, ready to install. */
    val ready: String? = null,
)
