import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("org.jetbrains.kotlin.multiplatform")
    id("com.android.kotlin.multiplatform.library")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.compose")
}
kotlin {
    android {
        namespace = "dev.amo.studio.shared"
        compileSdk = 36
        minSdk = 28
        androidResources { enable = true }
        compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
        // commonTest on the JVM (:shared:testAndroidHostTest): the shared logic without an emulator.
        withHostTest {}
    }
    // iOS (plans/ios.md 第 2d 步): a static framework "Shared" for iosApp; it builds only on the Mac (Kotlin/Native
    // skips these targets on Windows, kotlin.native.ignoreDisabledTargets). Xcode's build phase runs
    // :shared:embedAndSignAppleFrameworkForXcode, which also copies the fonts (Compose resources) into the app.
    listOf(iosArm64(), iosSimulatorArm64()).forEach { target ->
        target.binaries.framework { baseName = "Shared"; isStatic = true }
    }
    sourceSets {
        commonMain.dependencies {
            // Compose Multiplatform 1.11.1 = androidx compose ui 1.11.2 / material3 1.4.0 on Android.
            api("org.jetbrains.compose.runtime:runtime:1.11.1")
            api("org.jetbrains.compose.foundation:foundation:1.11.1")
            api("org.jetbrains.compose.ui:ui:1.11.1")
            api("org.jetbrains.compose.material3:material3:1.9.0")
            // 2b (2026-11-02): the fonts as Compose resources; the system back gesture without androidx.activity.
            implementation("org.jetbrains.compose.components:components-resources:1.11.1")
            implementation("org.jetbrains.compose.ui:ui-backhandler:1.11.1")
            api("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.2")
            // 2026-11-02 (plans/ios.md 第 2 步): what replaced OkHttp, org.json, java.io and java.time in the shared code.
            // Ktor 3.5.x: 3.6 brings okhttp 5.5, which needs compileSdk 37 (we build against 36).
            implementation("io.ktor:ktor-client-core:3.5.2")
            implementation("io.ktor:ktor-client-websockets:3.5.2")
            implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.12.0")
            implementation("org.jetbrains.kotlinx:kotlinx-datetime:0.8.0")
            api("com.squareup.okio:okio:3.18.2")
        }
        commonTest.dependencies {
            implementation(kotlin("test"))
        }
        androidMain.dependencies {
            implementation("androidx.activity:activity-compose:1.13.0")
            implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
            implementation("io.ktor:ktor-client-okhttp:3.5.2")
            // Self-update downloads (AppUpdate.kt) still use OkHttp directly.
            implementation("com.squareup.okhttp3:okhttp:5.3.0")
        }
        iosMain.dependencies {
            implementation("io.ktor:ktor-client-darwin:3.5.2")
        }
    }
}
compose.resources {
    packageOfResClass = "dev.amo.studio.res"
    generateResClass = always
}
