// The Android client is a separate Gradle build on purpose. It shares no code
// and no toolchain with the desktop app, and the repo's "exactly one runtime
// dependency" rule is about what ships inside Notch.exe — it does not reach in
// here. Nothing in the npm build depends on this directory.
plugins {
  id("com.android.application") version "8.7.3" apply false
  id("org.jetbrains.kotlin.android") version "2.0.21" apply false
  id("org.jetbrains.kotlin.plugin.compose") version "2.0.21" apply false
}
