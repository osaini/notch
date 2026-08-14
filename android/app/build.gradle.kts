plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
  id("org.jetbrains.kotlin.plugin.compose")
}

// OneDrive occasionally holds generated resource directories open on Windows.
// A caller can route disposable build output elsewhere without changing the
// normal Android Studio/CI layout: -PnotchBuildDir=C:\\path\\to\\build.
providers.gradleProperty("notchBuildDir").orNull?.let {
  layout.buildDirectory.set(file(it))
}

android {
  namespace = "dev.notch.companion"
  compileSdk = 35

  defaultConfig {
    applicationId = "dev.notch.companion"
    // 26 is where notification channels and adaptive icons land, which is what
    // the needs-input notification relies on.
    minSdk = 26
    targetSdk = 35
    versionCode = 1
    versionName = "0.1.0"
  }

  buildTypes {
    debug {
      // The only build type that matters here: this app is sideloaded, not
      // published, so there is no release signing config to speak of.
      applicationIdSuffix = ""
    }
    release {
      isMinifyEnabled = false
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  kotlinOptions { jvmTarget = "17" }
  buildFeatures { compose = true }
}

dependencies {
  implementation(platform("androidx.compose:compose-bom:2024.10.01"))
  implementation("androidx.compose.ui:ui")
  implementation("androidx.compose.ui:ui-tooling-preview")
  implementation("androidx.compose.material3:material3")
  implementation("androidx.activity:activity-compose:1.9.3")
  implementation("androidx.core:core-ktx:1.13.1")
  implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
  implementation("androidx.lifecycle:lifecycle-service:2.8.7")
  implementation("com.squareup.okhttp3:okhttp:4.12.0")
  // Wraps CameraX and the barcode decoder behind one Activity contract, which
  // is the whole QR feature in about ten lines. JSON stays on org.json, which
  // is in the framework — no serialization plugin, no codegen.
  implementation("com.journeyapps:zxing-android-embedded:4.3.0")
  testImplementation("junit:junit:4.13.2")
  debugImplementation("androidx.compose.ui:ui-tooling")
}
