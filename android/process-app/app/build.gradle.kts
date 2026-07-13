plugins {
    id("com.android.application")
}

android {
    namespace = "app.dispro.process"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.dispro.process"
        minSdk = 31
        targetSdk = 35
        versionCode = 107
        versionName = "0.1.7"
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
