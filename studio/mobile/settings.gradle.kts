pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); mavenCentral() }
}
rootProject.name = "AMOStudioMobile"
// 2026-11-02 (the user: iOS through Kotlin Multiplatform): shared = protocol, data and Compose screens for Android and
// iOS; app = the Android shell (Activity, manifest, resources). The iOS shell will be iosApp/, an Xcode project.
include(":app", ":shared")
