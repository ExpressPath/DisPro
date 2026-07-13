package app.dispro.process;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.UUID;
import org.json.JSONObject;

public final class MainActivity extends Activity {
    private static final String API_BASE_URL = "https://dis-pro-liart.vercel.app";
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private EditText emailInput;
    private EditText codeInput;
    private EditText sourceInput;
    private EditText hashInput;
    private EditText bytesInput;
    private EditText workloadInput;
    private EditText maxChargeInput;
    private TextView status;
    private TextView log;

    @Override
    protected void onCreate(Bundle bundle) {
        super.onCreate(bundle);
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 100);
        }
        setContentView(createLayout());
        renderStoredStatus();
    }

    private LinearLayout createLayout() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(32, 32, 32, 32);
        root.setGravity(Gravity.CENTER_HORIZONTAL);

        TextView title = new TextView(this);
        title.setText("Dispro Process");
        title.setTextSize(24);
        title.setGravity(Gravity.CENTER_HORIZONTAL);
        root.addView(title);

        status = new TextView(this);
        status.setText("locked");
        status.setGravity(Gravity.CENTER_HORIZONTAL);
        root.addView(status);

        emailInput = new EditText(this);
        emailInput.setHint("Email address");
        emailInput.setSingleLine(true);
        root.addView(emailInput);

        Button sendCode = new Button(this);
        sendCode.setText("Send verification code");
        sendCode.setOnClickListener(view -> requestCode());
        root.addView(sendCode);

        codeInput = new EditText(this);
        codeInput.setHint("6-digit code");
        codeInput.setSingleLine(true);
        root.addView(codeInput);

        Button verify = new Button(this);
        verify.setText("Verify and create API keys");
        verify.setOnClickListener(view -> verifyCode());
        root.addView(verify);

        Button start = new Button(this);
        start.setText("Start Processing");
        start.setOnClickListener(view -> {
            if (!SecurePrefs.hasAuth(this)) {
                append("Email verification is required before using Dispro.");
                return;
            }
            Intent intent = new Intent(this, DisproProcessService.class);
            intent.setAction(DisproProcessService.ACTION_START);
            startForegroundService(intent);
            status.setText("waiting");
            append("Process service started.");
        });
        root.addView(start);

        Button stop = new Button(this);
        stop.setText("Stop");
        stop.setOnClickListener(view -> {
            Intent intent = new Intent(this, DisproProcessService.class);
            intent.setAction(DisproProcessService.ACTION_STOP);
            startService(intent);
            status.setText("stopped");
            append("Stopped.");
        });
        root.addView(stop);

        Button billing = new Button(this);
        billing.setText("Register payment method");
        billing.setOnClickListener(view -> registerPayment());
        root.addView(billing);

        sourceInput = new EditText(this);
        sourceInput.setHint("Source URL or CID");
        sourceInput.setSingleLine(true);
        root.addView(sourceInput);

        hashInput = new EditText(this);
        hashInput.setHint("Content hash");
        hashInput.setSingleLine(true);
        root.addView(hashInput);

        bytesInput = new EditText(this);
        bytesInput.setHint("Byte size");
        bytesInput.setSingleLine(true);
        bytesInput.setText("1024");
        root.addView(bytesInput);

        workloadInput = new EditText(this);
        workloadInput.setHint("Workload");
        workloadInput.setSingleLine(true);
        workloadInput.setText("hash.compute");
        root.addView(workloadInput);

        maxChargeInput = new EditText(this);
        maxChargeInput.setHint("Max charge micro-yen");
        maxChargeInput.setSingleLine(true);
        root.addView(maxChargeInput);

        Button createOrder = new Button(this);
        createOrder.setText("Create Use Order");
        createOrder.setOnClickListener(view -> createUseOrder());
        root.addView(createOrder);

        Button update = new Button(this);
        update.setText("Open update");
        update.setOnClickListener(view -> openUpdate());
        root.addView(update);

        Button clear = new Button(this);
        clear.setText("Clear sign-in");
        clear.setOnClickListener(view -> {
            SecurePrefs.clear(this);
            status.setText("locked");
            append("Stored sign-in cleared.");
        });
        root.addView(clear);

        log = new TextView(this);
        log.setText("Ready.");
        root.addView(log);
        return root;
    }

    private void requestCode() {
        String email = emailInput.getText().toString();
        executor.execute(() -> {
            try {
                DisproApiClient api = new DisproApiClient(API_BASE_URL, null);
                JSONObject result = api.post("/auth/request-code", new JSONObject().put("email", email));
                append("Verification code sent to " + result.optString("email", email) + ".");
            } catch (Exception error) {
                append(error.getMessage());
            }
        });
    }

    private void registerPayment() {
        String sessionToken = SecurePrefs.get(this, "sessionToken", "");
        if (sessionToken.isEmpty()) {
            append("Email verification is required before billing setup.");
            return;
        }
        executor.execute(() -> {
            try {
                DisproApiClient api = new DisproApiClient(API_BASE_URL, sessionToken);
                String url = api.post("/billing/setup-session", new JSONObject()).optString("url", "");
                if (!url.startsWith("https://")) {
                    append("Payment setup is ready.");
                    return;
                }
                runOnUiThread(() -> startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))));
                append("Payment setup opened.");
            } catch (Exception error) {
                append(error.getMessage());
            }
        });
    }

    private void createUseOrder() {
        String useKey = SecurePrefs.get(this, "useApiKey", "");
        String sourceUri = sourceInput.getText().toString();
        String contentHash = hashInput.getText().toString();
        String byteSize = bytesInput.getText().toString();
        String workload = workloadInput.getText().toString();
        String maxCharge = maxChargeInput.getText().toString();
        if (useKey.isEmpty()) {
            append("Email verification is required before Use orders.");
            return;
        }
        executor.execute(() -> {
            try {
                JSONObject source = new JSONObject()
                    .put("kind", "url")
                    .put("uri", sourceUri)
                    .put("contentHash", contentHash)
                    .put("byteSize", Long.parseLong(byteSize));
                JSONObject order = new JSONObject()
                    .put("source", source)
                    .put("workload", workload)
                    .put("priority", "standard")
                    .put("verificationLevel", "standard");
                if (!maxCharge.trim().isEmpty()) order.put("maxChargeMicroYen", Long.parseLong(maxCharge));
                DisproApiClient api = new DisproApiClient(API_BASE_URL, useKey);
                JSONObject result = api.postWithIdempotency("/use/orders", order, "android-use-" + UUID.randomUUID());
                append("Use order created: " + result.getJSONObject("order").optString("id"));
            } catch (Exception error) {
                append(error.getMessage());
            }
        });
    }

    private void verifyCode() {
        String email = emailInput.getText().toString();
        String code = codeInput.getText().toString();
        executor.execute(() -> {
            try {
                DisproApiClient api = new DisproApiClient(API_BASE_URL, null);
                JSONObject session = api.post(
                    "/auth/verify",
                    new JSONObject().put("email", email).put("code", code)
                );
                String sessionToken = session.getString("sessionToken");
                DisproApiClient sessionApi = new DisproApiClient(API_BASE_URL, sessionToken);
                String processKey = sessionApi.post(
                    "/auth/api-keys",
                    new JSONObject().put("label", "process-android-v1").put("purpose", "process")
                ).getString("secret");
                String useKey = sessionApi.post(
                    "/auth/api-keys",
                    new JSONObject().put("label", "use-android-v1").put("purpose", "use")
                ).getString("secret");
                SecurePrefs.saveAuth(this, sessionToken, processKey, useKey, session.getJSONObject("user").optString("email"));
                runOnUiThread(() -> status.setText("verified"));
                append("Verified. Android Process API key is ready.");
            } catch (Exception error) {
                append(error.getMessage());
            }
        });
    }

    private void renderStoredStatus() {
        status.setText(SecurePrefs.hasAuth(this) ? "verified" : "locked");
    }

    private void openUpdate() {
        String url = SecurePrefs.get(this, "updateUrl", "");
        if (url.isEmpty() || !url.startsWith("https://")) {
            append("No signed Android update is waiting.");
            return;
        }
        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
    }

    private void append(String message) {
        runOnUiThread(() -> log.setText(message + "\n" + log.getText()));
    }
}
