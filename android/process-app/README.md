# Dispro Process Android v1

Android v1 is a lightweight Process node for signed, approved Dispro jobs.

- Runner family: `android-process-v1`
- Workloads: `hash.compute`, `proof.verify`, `echo.test`, `data.transform.basic`, `dispro.storage.anchor`, `dispro.transaction.anchor`, `dispro.app.update`
- Execution model: foreground service, one job at a time, API-signed job envelopes only
- Token storage: Android Keystore AES-GCM encrypted SharedPreferences values
- Update route: signed `dispro.app.update` jobs with `downloadUrl`, `sha256`, and optional Play Store URL
- Use mode: opens Stripe setup and creates URL/CID Use orders through the official API

Build locally with Android SDK installed:

```powershell
gradle -p android/process-app :app:assembleRelease
```

The generated APK is expected at:

```text
android/process-app/app/build/outputs/apk/release/app-release-unsigned.apk
```
