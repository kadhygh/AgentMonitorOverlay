package dev.amo.studio

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.websocket.WebSockets
import okio.FileSystem
import okio.Path
import okio.Path.Companion.toOkioPath
import java.security.KeyStore
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** The Android phone under the shared code (2026-11-02, plans/ios.md 第 2 步): what StudioRepository had inline before. */
class AndroidPlatform(context: Context) : Platform {
    private val app = context.applicationContext
    private val packageInfo = app.packageManager.getPackageInfo(app.packageName, 0)
    override val versionCode: Long = packageInfo.longVersionCode
    override val versionName: String = packageInfo.versionName ?: ""
    override val deviceName = "Android 手机"
    override val fileSystem: FileSystem = FileSystem.SYSTEM
    override val filesDir: Path = app.filesDir.toOkioPath()
    override val prefs: Prefs = AndroidPrefs(app.getSharedPreferences("studio", Context.MODE_PRIVATE))
    override val drafts: Prefs = AndroidPrefs(app.getSharedPreferences("chat-drafts", Context.MODE_PRIVATE))
    override val updater: Updater = AndroidUpdater(app)

    // The same OkHttp settings as before the move to Ktor: a ping every 15 s keeps the devices socket alive through NAT.
    override fun httpClient() = HttpClient(OkHttp) {
        engine { config { pingInterval(15, TimeUnit.SECONDS); connectTimeout(10, TimeUnit.SECONDS); readTimeout(30, TimeUnit.SECONDS) } }
        install(WebSockets)
    }

    private fun secret(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("amo-studio-token", null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("amo-studio-token", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    override fun encrypt(text: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, secret())
        return Base64.encodeToString(cipher.iv + cipher.doFinal(text.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
    }
    override fun decrypt(text: String): String {
        val bytes = Base64.decode(text, Base64.NO_WRAP); require(bytes.size > 12)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.DECRYPT_MODE, secret(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        return String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
    }
}

private class AndroidPrefs(private val prefs: SharedPreferences) : Prefs {
    override fun string(key: String): String? = prefs.getString(key, null)
    override fun boolean(key: String, fallback: Boolean) = prefs.getBoolean(key, fallback)
    override fun long(key: String, fallback: Long) = prefs.getLong(key, fallback)
    override fun edit(now: Boolean, changes: PrefsEditor.() -> Unit) {
        val editor = prefs.edit()
        object : PrefsEditor {
            override fun put(key: String, value: String) { editor.putString(key, value) }
            override fun put(key: String, value: Boolean) { editor.putBoolean(key, value) }
            override fun put(key: String, value: Long) { editor.putLong(key, value) }
            override fun remove(key: String) { editor.remove(key) }
        }.changes()
        if (now) editor.commit() else editor.apply()
    }
}

/** As before the shared module: `StudioRepository(context)` (MainActivity, the instrumentation tests). */
fun StudioRepository(context: Context): StudioRepository = StudioRepository(AndroidPlatform(context))
