package dev.amo.studio

import io.ktor.client.HttpClient
import io.ktor.client.engine.darwin.Darwin
import io.ktor.client.plugins.websocket.WebSockets
import kotlinx.cinterop.*
import okio.FileSystem
import okio.Path
import okio.Path.Companion.toPath
import platform.CoreFoundation.*
import platform.Foundation.*
import platform.Security.*
import platform.UIKit.UIDevice

/**
 * The iPhone under the shared code (2026-11-02, plans/ios.md 第 2d 步). Updates come from TestFlight, so no updater.
 * The account key is encrypted like on Android: with a key that stays in the phone (here an EC key in the Keychain,
 * ECIES with AES-GCM); only the encrypted text is kept in the settings.
 */
class IosPlatform : Platform {
    private val info = NSBundle.mainBundle.infoDictionary
    override val versionCode: Long = (info?.get("CFBundleVersion") as? String)?.toLongOrNull() ?: 0L
    override val versionName: String = info?.get("CFBundleShortVersionString") as? String ?: ""
    // "iPhone" / "iPad": UIDevice.name is only the model too since iOS 16, without a special entitlement.
    override val deviceName: String = UIDevice.currentDevice.model
    override val fileSystem: FileSystem = FileSystem.SYSTEM
    override val filesDir: Path = run {
        val url = NSFileManager.defaultManager.URLsForDirectory(NSApplicationSupportDirectory, NSUserDomainMask).first() as NSURL
        url.path!!.toPath().also { FileSystem.SYSTEM.createDirectories(it) }
    }
    override val prefs: Prefs = IosPrefs(NSUserDefaults.standardUserDefaults)
    override val drafts: Prefs = IosPrefs(NSUserDefaults(suiteName = "chat-drafts"))
    override val updater: Updater? = null

    // As on Android: a ping every 15 s keeps the devices socket alive through NAT; 30 s for a request.
    override fun httpClient() = HttpClient(Darwin) {
        engine { configureRequest { setTimeoutInterval(30.0) } }
        install(WebSockets) { pingIntervalMillis = 15_000 }
    }

    override fun encrypt(text: String): String = TokenKey.encrypt(text)
    override fun decrypt(text: String): String = TokenKey.decrypt(text)
}

private class IosPrefs(private val defaults: NSUserDefaults) : Prefs {
    override fun string(key: String): String? = defaults.stringForKey(key)
    override fun boolean(key: String, fallback: Boolean) = if (defaults.objectForKey(key) == null) fallback else defaults.boolForKey(key)
    override fun long(key: String, fallback: Long) = (defaults.objectForKey(key) as? NSNumber)?.longLongValue ?: fallback
    override fun edit(now: Boolean, changes: PrefsEditor.() -> Unit) {
        object : PrefsEditor {
            override fun put(key: String, value: String) = defaults.setObject(value, key)
            override fun put(key: String, value: Boolean) = defaults.setBool(value, key)
            override fun put(key: String, value: Long) = defaults.setObject(NSNumber(longLong = value), key)
            override fun remove(key: String) = defaults.removeObjectForKey(key)
        }.changes()
        // NSUserDefaults writes on its own soon after; `now` (a message about to be sent) does not wait for that.
        if (now) defaults.synchronize()
    }
}

@OptIn(ExperimentalForeignApi::class, BetaInteropApi::class)
private object TokenKey {
    private const val TAG = "dev.amo.studio.token"

    fun encrypt(text: String): String = memScoped {
        val key = privateKey()
        val public = SecKeyCopyPublicKey(key) ?: error("没有公钥")
        val plain = cf(text.encodeToByteArray().toNSData())
        val failure = alloc<CFErrorRefVar>()
        val sealed = SecKeyCreateEncryptedData(public, kSecKeyAlgorithmECIESEncryptionCofactorVariableIVX963SHA256AESGCM, plain?.reinterpret(), failure.ptr)
        CFRelease(public); CFRelease(key); plain?.let { CFRelease(it) }
        val data = CFBridgingRelease(sealed) as? NSData ?: error("加密失败")
        data.base64EncodedStringWithOptions(0u)
    }

    fun decrypt(text: String): String = memScoped {
        val bytes = NSData.create(base64EncodedString = text, options = 0u) ?: error("不是加密过的账号")
        val key = find() ?: error("钥匙串里没有密钥")
        val sealed = cf(bytes)
        val failure = alloc<CFErrorRefVar>()
        val plain = SecKeyCreateDecryptedData(key, kSecKeyAlgorithmECIESEncryptionCofactorVariableIVX963SHA256AESGCM, sealed?.reinterpret(), failure.ptr)
        CFRelease(key); sealed?.let { CFRelease(it) }
        val data = CFBridgingRelease(plain) as? NSData ?: error("解密失败")
        data.toByteArray().decodeToString()
    }

    private fun privateKey(): SecKeyRef = find() ?: create()

    private fun find(): SecKeyRef? = memScoped {
        val tag = cf(TAG.encodeToByteArray().toNSData())
        val query = dictionary(kSecClass to kSecClassKey, kSecAttrApplicationTag to tag, kSecAttrKeyType to kSecAttrKeyTypeECSECPrimeRandom, kSecReturnRef to kCFBooleanTrue)
        val result = alloc<CFTypeRefVar>()
        val status = SecItemCopyMatching(query, result.ptr)
        CFRelease(query); tag?.let { CFRelease(it) }
        if (status == errSecSuccess) result.value?.reinterpret() else null
    }

    private fun create(): SecKeyRef = memScoped {
        val tag = cf(TAG.encodeToByteArray().toNSData())
        val size = cf(NSNumber(int = 256))
        val private = dictionary(kSecAttrIsPermanent to kCFBooleanTrue, kSecAttrApplicationTag to tag)
        // After the first unlock, this device only: not in backups, not on another phone.
        val attributes = dictionary(kSecAttrKeyType to kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeySizeInBits to size, kSecAttrAccessible to kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, kSecPrivateKeyAttrs to private)
        val failure = alloc<CFErrorRefVar>()
        val key = SecKeyCreateRandomKey(attributes, failure.ptr)
        CFRelease(attributes); CFRelease(private); tag?.let { CFRelease(it) }; size?.let { CFRelease(it) }
        key ?: error("没能在钥匙串里建密钥")
    }

    private fun cf(value: Any): CFTypeRef? = CFBridgingRetain(value)

    private fun dictionary(vararg entries: Pair<CPointer<*>?, CPointer<*>?>): CFMutableDictionaryRef {
        val dict = CFDictionaryCreateMutable(null, entries.size.toLong(), kCFTypeDictionaryKeyCallBacks.ptr, kCFTypeDictionaryValueCallBacks.ptr)!!
        for ((k, v) in entries) CFDictionaryAddValue(dict, k, v)
        return dict
    }
}

@OptIn(ExperimentalForeignApi::class, kotlinx.cinterop.BetaInteropApi::class)
internal fun ByteArray.toNSData(): NSData = if (isEmpty()) NSData() else usePinned { NSData.create(bytes = it.addressOf(0), length = size.toULong()) }

@OptIn(ExperimentalForeignApi::class)
internal fun NSData.toByteArray(): ByteArray {
    val size = length.toInt()
    if (size == 0) return ByteArray(0)
    return ByteArray(size).apply { usePinned { platform.posix.memcpy(it.addressOf(0), bytes, length) } }
}
