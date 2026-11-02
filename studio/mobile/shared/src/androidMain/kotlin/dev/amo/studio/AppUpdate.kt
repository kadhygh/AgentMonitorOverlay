package dev.amo.studio

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

// 2026-10-31 (the user): the app updates itself from the team server. The newest build is android/latest.json in the
// server's platform dir (scripts/relay-mac.mjs android-publish), read at /api/platform/android with the account's key;
// the APK comes from /platform/android/<file>, is checked by size and sha256, and goes to Android's own installer. An
// APK signed with another key than the installed app is refused by Android, not by this code.

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
    /** The checked APK, ready to install. */
    val ready: File? = null,
)

internal object AppUpdates {
    const val MIME = "application/vnd.android.package-archive"
    private val NAME = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\\.apk$")
    private val SHA = Regex("^[0-9a-f]{64}$")

    fun dir(context: Context) = File(context.cacheDir, "updates")

    /** The server's newest build, or null when it has none published (404). */
    fun latest(client: OkHttpClient, account: Account): AndroidLatest? {
        val request = Request.Builder().url("${account.server}/api/platform/android").header("Authorization", "Bearer ${account.key}").build()
        client.newCall(request).execute().use { response ->
            if (response.code == 404) return null
            val json = runCatching { JSONObject(response.body?.string().orEmpty()) }.getOrElse { JSONObject() }
            if (!response.isSuccessful) error(json.str("message", "检查更新失败：服务器返回 ${response.code}"))
            val latest = AndroidLatest(json.str("version"), json.optInt("versionCode", 0), json.str("file"), json.optLong("size", -1), json.str("sha256"), json.str("notes"))
            require(latest.versionCode > 0 && NAME.matches(latest.file) && latest.size > 0 && SHA.matches(latest.sha256)) { "服务器上的安卓版信息不完整" }
            return latest
        }
    }

    /** Downloads `latest` into dir(context), checked; `progress` gets the bytes so far. */
    fun download(client: OkHttpClient, context: Context, account: Account, latest: AndroidLatest, progress: (Long) -> Unit): File {
        val dir = dir(context).apply { mkdirs() }
        val target = File(dir, latest.file)
        if (target.length() == latest.size && sha256(target) == latest.sha256) return target
        dir.listFiles()?.forEach { it.delete() }
        val part = File(dir, "${latest.file}.part")
        val request = Request.Builder().url("${account.server}/platform/android/${latest.file}").header("Authorization", "Bearer ${account.key}").build()
        client.newBuilder().readTimeout(60, TimeUnit.SECONDS).build().newCall(request).execute().use { response ->
            if (!response.isSuccessful) error("下载新版本失败：服务器返回 ${response.code}")
            val digest = MessageDigest.getInstance("SHA-256")
            var total = 0L
            var told = 0L
            response.body!!.byteStream().use { input ->
                part.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        if (Thread.currentThread().isInterrupted) error("下载已取消")
                        val n = input.read(buffer)
                        if (n < 0) break
                        output.write(buffer, 0, n)
                        digest.update(buffer, 0, n)
                        total += n
                        if (total > latest.size) error("下载的文件比服务器说的大，已丢弃")
                        if (total - told >= 256 * 1024) { told = total; progress(total) }
                    }
                }
            }
            progress(total)
            val sha = digest.digest().joinToString("") { "%02x".format(it) }
            if (total != latest.size || sha != latest.sha256) { part.delete(); error("下载的安装包校验不对（可能没下完），请重试") }
        }
        if (!part.renameTo(target)) error("保存安装包失败")
        return target
    }

    /** Where to send the person: Android's installer, or first the page that lets this app install apps. */
    fun installIntent(context: Context, file: File): Intent =
        if (!context.packageManager.canRequestPackageInstalls()) Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        else Intent(Intent.ACTION_VIEW).setDataAndType(FileProvider.getUriForFile(context, "${context.packageName}.updates", file), MIME).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input -> val buffer = ByteArray(64 * 1024); while (true) { val n = input.read(buffer); if (n < 0) break; digest.update(buffer, 0, n) } }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}
