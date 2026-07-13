package app.dispro.process;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.provider.Settings;
import android.util.Base64;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;
import java.util.UUID;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONArray;
import org.json.JSONObject;

public final class DisproProcessService extends Service {
    public static final String ACTION_START = "app.dispro.process.START";
    public static final String ACTION_STOP = "app.dispro.process.STOP";
    private static final String CHANNEL_ID = "dispro-process";
    private Thread workerThread;
    private volatile boolean running;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (ACTION_STOP.equals(intent == null ? null : intent.getAction())) {
            stopWorker();
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }
        startForeground(1, notification("Waiting for signed jobs"));
        startWorker();
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        stopWorker();
        super.onDestroy();
    }

    private void startWorker() {
        if (running) return;
        running = true;
        workerThread = new Thread(() -> new ProcessWorker(this, message -> {
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) manager.notify(1, notification(message));
        }).run(() -> running), "dispro-process-worker");
        workerThread.start();
    }

    private void stopWorker() {
        running = false;
        if (workerThread != null) workerThread.interrupt();
    }

    private Notification notification(String message) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26 && manager != null) {
            manager.createNotificationChannel(new NotificationChannel(CHANNEL_ID, "Dispro Process", NotificationManager.IMPORTANCE_LOW));
        }
        return new Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("Dispro Process")
            .setContentText(message)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .build();
    }
}

final class ProcessWorker {
    private static final String API_BASE_URL = "https://dis-pro-liart.vercel.app";
    private static final String[] WORKLOADS = {
        "hash.compute",
        "proof.verify",
        "echo.test",
        "data.transform.basic",
        "dispro.storage.anchor",
        "dispro.transaction.anchor",
        "dispro.app.update"
    };
    private final Context context;
    private final StatusSink statusSink;

    ProcessWorker(Context context, StatusSink statusSink) {
        this.context = context;
        this.statusSink = statusSink;
    }

    void run(RunFlag flag) {
        try {
            String processKey = SecurePrefs.get(context, "processApiKey", "");
            if (processKey.isEmpty()) {
                statusSink.accept("Email verification required");
                return;
            }
            DisproApiClient api = new DisproApiClient(API_BASE_URL, processKey);
            String publicKey = api.get("/process/signing-key").getString("publicKey");
            JSONObject node = api.post("/process/register", createRegistration()).getJSONObject("node");
            while (flag.isRunning()) {
                try {
                    JSONObject lease = api.post(
                        "/process/lease",
                        new JSONObject().put("nodeId", node.getString("id")).put("supportedWorkloads", new JSONArray(WORKLOADS))
                    );
                    if ("idle".equals(lease.optString("status"))) {
                        statusSink.accept("Waiting for signed jobs");
                        Thread.sleep(30_000);
                        continue;
                    }
                    JSONObject job = lease.getJSONObject("job");
                    statusSink.accept("Running " + job.getString("workload"));
                    JSONObject result = execute(job, publicKey);
                    String resultNonce = "rnonce_" + sha256(job.getString("jobId") + ":" + job.optString("nonce") + ":" + result.getString("resultHash") + ":" + System.currentTimeMillis());
                    JSONObject signaturePayload = new JSONObject()
                        .put("nodeId", node.getString("id"))
                        .put("jobId", job.getString("jobId"))
                        .put("resultHash", result.getString("resultHash"))
                        .put("status", result.getString("status"))
                        .put("resultNonce", resultNonce);
                    api.post("/process/results", result
                        .put("nodeId", node.getString("id"))
                        .put("jobId", job.getString("jobId"))
                        .put("resultNonce", resultNonce)
                        .put("nodePublicKey", NodeKeys.publicKeyPem())
                        .put("nodeSignature", NodeKeys.sign(signaturePayload)));
                    statusSink.accept("Submitted " + job.getString("jobId"));
                    Thread.sleep(2_000);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    return;
                } catch (Exception error) {
                    statusSink.accept(error.getMessage());
                    Thread.sleep(15_000);
                }
            }
        } catch (Exception error) {
            statusSink.accept(error.getMessage());
        }
    }

    private JSONObject execute(JSONObject job, String publicKeyPem) throws Exception {
        long started = System.currentTimeMillis();
        JSONObject input = job.optJSONObject("inputRef");
        if (input == null) input = new JSONObject();
        if (!verifyJob(job, publicKeyPem)) return result("rejected", "Invalid job signature.", "", input, started);
        if (job.has("expiresAt") && java.time.Instant.parse(job.getString("expiresAt")).toEpochMilli() <= System.currentTimeMillis()) {
            return result("rejected", "Job lease expired.", "", input, started);
        }
        String workload = job.getString("workload");
        try {
            JSONObject output;
            if ("echo.test".equals(workload)) output = new JSONObject().put("echo", input);
            else if ("hash.compute".equals(workload)) output = new JSONObject().put("algorithm", "sha256").put("hash", sha256(input.optString("text", input.toString())));
            else if ("proof.verify".equals(workload)) {
                String actual = sha256(input.optString("payload", ""));
                output = new JSONObject().put("verified", actual.equals(input.optString("expectedHash"))).put("actualHash", actual);
            } else if ("data.transform.basic".equals(workload)) output = new JSONObject().put("records", input.optJSONArray("records") == null ? new JSONArray() : input.optJSONArray("records"));
            else if ("dispro.storage.anchor".equals(workload) || "dispro.transaction.anchor".equals(workload)) {
                String payloadHash = sha256(input.optString("encryptedJson", ""));
                output = new JSONObject().put("status", "anchored").put("provider", input.optString("provider", "local")).put("cid", "android-" + payloadHash.substring(0, 46)).put("payloadHash", payloadHash);
            } else if ("dispro.app.update".equals(workload)) {
                JSONObject manifest = input.optJSONObject("manifest") == null ? new JSONObject() : input.optJSONObject("manifest");
                String updateUrl = manifest.optString("playStoreUrl", manifest.optString("downloadUrl", ""));
                SecurePrefs.put(context, "updateUrl", updateUrl);
                output = new JSONObject().put("updateAvailable", true).put("manifest", manifest);
            } else {
                return result("rejected", "Unsupported workload: " + workload, "", input, started);
            }
            return result("completed", "", output.toString(), input, started);
        } catch (Exception error) {
            return result("failed", error.getMessage(), "", input, started);
        }
    }

    private JSONObject result(String status, String stderr, String stdout, JSONObject input, long started) throws Exception {
        String resultHash = sha256(status + ":" + stdout + ":" + stderr);
        return new JSONObject()
            .put("status", status)
            .put("resultHash", resultHash)
            .put("stdout", stdout)
            .put("stderr", stderr)
            .put("durationMs", Math.max(0, System.currentTimeMillis() - started))
            .put("metrics", new JSONObject()
                .put("durationMs", Math.max(0, System.currentTimeMillis() - started))
                .put("inputBytes", input.toString().getBytes(StandardCharsets.UTF_8).length)
                .put("outputBytes", stdout.getBytes(StandardCharsets.UTF_8).length)
                .put("computeUnits", 1)
                .put("runnerWorkUnits", 1))
            .put("errorMessage", stderr);
    }

    private JSONObject createRegistration() throws Exception {
        String machineId = SecurePrefs.get(context, "machineId", "");
        if (machineId.isEmpty()) {
            machineId = "android-" + UUID.randomUUID();
            SecurePrefs.put(context, "machineId", machineId);
        }
        return new JSONObject()
            .put("machineId", machineId)
            .put("deviceName", Build.MANUFACTURER + " " + Build.MODEL)
            .put("os", "Android " + Build.VERSION.RELEASE)
            .put("appVersion", BuildConfig.VERSION_NAME)
            .put("cpuCores", Runtime.getRuntime().availableProcessors())
            .put("memoryGb", 4)
            .put("supportedWorkloads", new JSONArray(WORKLOADS))
            .put("deviceClass", "mobile")
            .put("benchmarkScores", new JSONObject().put("cpu", Runtime.getRuntime().availableProcessors() * 60).put("hash", Runtime.getRuntime().availableProcessors() * 60).put("memory", 400))
            .put("bandwidthMbps", 10)
            .put("thermalState", "unknown")
            .put("batteryState", "unknown")
            .put("maxConcurrentJobs", 1)
            .put("runnerFamily", "android-process-v1")
            .put("clusterWords", new JSONArray(new String[] { "android-process-v1", "mobile", "verify", "hash", "proof" }))
            .put("nodePublicKey", NodeKeys.publicKeyPem())
            .put("androidId", Settings.Secure.getString(context.getContentResolver(), Settings.Secure.ANDROID_ID));
    }

    private boolean verifyJob(JSONObject job, String publicKeyPem) {
        try {
            String signature = job.getString("signature");
            JSONObject unsigned = new JSONObject(job.toString());
            unsigned.remove("signature");
            Signature verifier = Signature.getInstance("Ed25519");
            verifier.initVerify(KeyFactory.getInstance("Ed25519").generatePublic(new X509EncodedKeySpec(pemBody(publicKeyPem))));
            verifier.update(JsonUtil.stableStringify(unsigned).getBytes(StandardCharsets.UTF_8));
            return verifier.verify(base64UrlDecode(signature));
        } catch (Exception error) {
            return false;
        }
    }

    private byte[] pemBody(String pem) {
        return Base64.decode(pem.replace("-----BEGIN PUBLIC KEY-----", "").replace("-----END PUBLIC KEY-----", "").replaceAll("\\s", ""), Base64.DEFAULT);
    }

    private String sha256(String value) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder builder = new StringBuilder();
        for (byte b : digest) builder.append(String.format("%02x", b));
        return builder.toString();
    }

    private byte[] base64UrlDecode(String value) {
        return Base64.decode(value, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
    }

    interface StatusSink { void accept(String message); }
    interface RunFlag { boolean isRunning(); }
}

final class NodeKeys {
    private static KeyPair keyPair;

    static synchronized String publicKeyPem() throws Exception {
        return toPem(keyPair().getPublic());
    }

    static synchronized String sign(JSONObject payload) throws Exception {
        Signature signer = Signature.getInstance("Ed25519");
        signer.initSign(keyPair().getPrivate());
        signer.update(JsonUtil.stableStringify(payload).getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(signer.sign(), Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
    }

    private static KeyPair keyPair() throws Exception {
        if (keyPair == null) {
            KeyPairGenerator generator = KeyPairGenerator.getInstance("Ed25519");
            keyPair = generator.generateKeyPair();
        }
        return keyPair;
    }

    private static String toPem(PublicKey key) {
        String body = Base64.encodeToString(key.getEncoded(), Base64.NO_WRAP);
        StringBuilder wrapped = new StringBuilder();
        for (int i = 0; i < body.length(); i += 64) {
            wrapped.append(body, i, Math.min(i + 64, body.length())).append('\n');
        }
        return "-----BEGIN PUBLIC KEY-----\n" + wrapped + "-----END PUBLIC KEY-----";
    }
}

final class DisproApiClient {
    private final String baseUrl;
    private final String token;

    DisproApiClient(String baseUrl, String token) {
        this.baseUrl = baseUrl;
        this.token = token;
    }

    JSONObject get(String path) throws Exception {
        return request("GET", path, null);
    }

    JSONObject post(String path, JSONObject body) throws Exception {
        return request("POST", path, body, null);
    }

    JSONObject postWithIdempotency(String path, JSONObject body, String idempotencyKey) throws Exception {
        return request("POST", path, body, idempotencyKey);
    }

    private JSONObject request(String method, String path, JSONObject body) throws Exception {
        return request(method, path, body, null);
    }

    private JSONObject request(String method, String path, JSONObject body, String idempotencyKey) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(baseUrl + path).openConnection();
        connection.setRequestMethod(method);
        connection.setRequestProperty("content-type", "application/json");
        if (token != null && !token.isEmpty()) connection.setRequestProperty("authorization", "Bearer " + token);
        if (idempotencyKey != null && !idempotencyKey.isEmpty()) connection.setRequestProperty("idempotency-key", idempotencyKey);
        if (body != null) {
            connection.setDoOutput(true);
            try (OutputStream stream = connection.getOutputStream()) {
                stream.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
        }
        int status = connection.getResponseCode();
        BufferedReader reader = new BufferedReader(new InputStreamReader(
            status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream(),
            StandardCharsets.UTF_8
        ));
        StringBuilder text = new StringBuilder();
        for (String line; (line = reader.readLine()) != null;) text.append(line);
        JSONObject payload = text.length() == 0 ? new JSONObject() : new JSONObject(text.toString());
        if (status < 200 || status >= 300) throw new IllegalStateException(payload.optJSONObject("error") == null ? "API request failed: " + status : payload.getJSONObject("error").optString("message"));
        return payload;
    }
}

final class SecurePrefs {
    private static final String PREFS = "dispro-secure";
    private static final String KEY_ALIAS = "dispro-process-auth";

    static boolean hasAuth(Context context) {
        return !get(context, "processApiKey", "").isEmpty();
    }

    static void saveAuth(Context context, String sessionToken, String processApiKey, String useApiKey, String email) {
        put(context, "sessionToken", sessionToken);
        put(context, "processApiKey", processApiKey);
        put(context, "useApiKey", useApiKey);
        put(context, "email", email);
    }

    static String get(Context context, String key, String fallback) {
        try {
            String packed = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(key, "");
            if (packed == null || packed.isEmpty()) return fallback;
            String[] parts = packed.split("\\.", 2);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
            return new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8);
        } catch (Exception error) {
            return fallback;
        }
    }

    static void put(Context context, String key, String value) {
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
            String packed = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + "." +
                Base64.encodeToString(cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(key, packed).apply();
        } catch (Exception error) {
            throw new IllegalStateException("Could not store secure Dispro data.", error);
        }
    }

    static void clear(Context context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply();
    }

    private static SecretKey getOrCreateKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(KEY_ALIAS)) return ((KeyStore.SecretKeyEntry) store.getEntry(KEY_ALIAS, null)).getSecretKey();
        KeyGenerator generator = KeyGenerator.getInstance("AES", "AndroidKeyStore");
        generator.init(new android.security.keystore.KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            android.security.keystore.KeyProperties.PURPOSE_ENCRYPT | android.security.keystore.KeyProperties.PURPOSE_DECRYPT
        ).setBlockModes(android.security.keystore.KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(android.security.keystore.KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .build());
        return generator.generateKey();
    }
}

final class JsonUtil {
    static String stableStringify(Object value) throws Exception {
        if (value == null || value == JSONObject.NULL) return "null";
        if (value instanceof JSONObject object) {
            List<String> keys = new ArrayList<>();
            for (Iterator<String> it = object.keys(); it.hasNext();) keys.add(it.next());
            Collections.sort(keys);
            StringBuilder builder = new StringBuilder("{");
            for (int i = 0; i < keys.size(); i++) {
                if (i > 0) builder.append(",");
                String key = keys.get(i);
                builder.append(JSONObject.quote(key)).append(":").append(stableStringify(object.get(key)));
            }
            return builder.append("}").toString();
        }
        if (value instanceof JSONArray array) {
            StringBuilder builder = new StringBuilder("[");
            for (int i = 0; i < array.length(); i++) {
                if (i > 0) builder.append(",");
                builder.append(stableStringify(array.get(i)));
            }
            return builder.append("]").toString();
        }
        if (value instanceof Number || value instanceof Boolean) return String.valueOf(value);
        return JSONObject.quote(String.valueOf(value));
    }
}
