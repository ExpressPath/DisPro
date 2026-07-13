# Android Process App v1

Android v1 is a lightweight Earn - Process node for phones and tablets.

## Scope

- Email code sign-in through the official Dispro API.
- Automatic creation of `process-android-v1` and `use-android-v1` API keys.
- Android Keystore encrypted local token storage.
- Foreground Process service that polls `/process/lease`.
- Minimal Use mode for Stripe setup URL opening and URL/CID order creation.
- Signed job verification before execution.
- Safe bundled workloads only:
  - `hash.compute`
  - `proof.verify`
  - `echo.test`
  - `data.transform.basic`
  - `dispro.storage.anchor`
  - `dispro.transaction.anchor`
  - `dispro.app.update`
- Result submission with node Ed25519 signatures.

Android is registered as `runnerFamily: "android-process-v1"` and `deviceClass: "mobile"`.
The scheduler should prefer it for verification, hash/proof checks, anchor jobs, and light workloads.

## Build

Generate a version-synced Android source package:

```powershell
npm.cmd run android:build
```

Build the APK on a machine with Android SDK and Gradle:

```powershell
gradle -p dist/android-process :app:assembleRelease
```

The release workflow builds the APK on GitHub Actions and uploads:

- `Dispro-Process-Android.apk`
- `Dispro-Process-Android.sha256`
- `android-process-manifest.json`

## Site And API Env

The official download manifest reads:

- `DISPRO_ANDROID_PROCESS_DOWNLOAD_VERSION`
- `DISPRO_ANDROID_PROCESS_DOWNLOAD_URL`
- `DISPRO_ANDROID_PROCESS_SHA256`
- `DISPRO_ANDROID_PROCESS_SIZE_BYTES`

The signed update special route reads:

- `DISPRO_ANDROID_PROCESS_UPDATE_VERSION`
- `DISPRO_ANDROID_PROCESS_UPDATE_URL`
- `DISPRO_ANDROID_PROCESS_UPDATE_SHA256`
- `DISPRO_ANDROID_PROCESS_UPDATE_CHANNEL`
- `DISPRO_ANDROID_PROCESS_UPDATE_MANDATORY`
- `DISPRO_ANDROID_PROCESS_UPDATE_NOTES`
- `DISPRO_ANDROID_PROCESS_PLAY_STORE_URL`

If `DISPRO_ANDROID_PROCESS_PLAY_STORE_URL` is set, the Android app opens that URL for updates.
Otherwise it opens the signed APK download URL.
