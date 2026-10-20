package net.ozziur.imperium;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.VibrationAttributes;
import android.view.HapticFeedbackConstants;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.util.Base64;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.webkit.WebViewAssetLoader;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * Contenitore Android dell'app web (cartella /web del repository).
 *
 * Serve gli asset da un'origine https locale (necessaria per IndexedDB, fetch e
 * WebAssembly) tramite WebViewAssetLoader.
 */
public class MainActivity extends ComponentActivity {

    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/index.html";

    private WebView webView;
    private ValueCallback<Uri[]> pendingFileCallback;
    private byte[] pendingExport;
    private Vibrator vibrator;

    private final ActivityResultLauncher<String[]> openDocument =
            registerForActivityResult(new ActivityResultContracts.OpenDocument(), uri -> {
                if (pendingFileCallback != null) {
                    pendingFileCallback.onReceiveValue(uri == null ? null : new Uri[]{uri});
                    pendingFileCallback = null;
                }
            });

    private final ActivityResultLauncher<String> createDocument =
            registerForActivityResult(new ActivityResultContracts.CreateDocument("application/octet-stream"), uri -> {
                boolean ok = false;
                if (uri != null && pendingExport != null) {
                    try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                        if (out != null) {
                            out.write(pendingExport);
                            ok = true;
                        }
                    } catch (IOException ignored) {
                    }
                }
                pendingExport = null;
                callJs("window.onAndroidExportDone && window.onAndroidExportDone(" + ok + ")");
            });

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        vibrator = getSystemService(Vibrator.class);

        webView = new WebView(this);
        webView.setBackgroundColor(0xFF0F1412);
        setContentView(webView);
        hideSystemBars();

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);

        WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/", new AppAssetHandler())
                .build();

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (HOST.equals(url.getHost())) return false;
                // I link esterni (Pokédex online, Discord...) si aprono nel browser.
                startActivity(new Intent(Intent.ACTION_VIEW, url));
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingFileCallback != null) pendingFileCallback.onReceiveValue(null);
                pendingFileCallback = callback;
                openDocument.launch(new String[]{"*/*"});
                return true;
            }
        });

        webView.addJavascriptInterface(new Bridge(), "AndroidBridge");

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                webView.evaluateJavascript(
                        "(window.onAndroidBack && window.onAndroidBack()) ? 'handled' : 'exit'",
                        result -> {
                            if (result == null || !result.contains("handled")) moveTaskToBack(true);
                        });
            }
        });

        if (savedInstanceState == null) webView.loadUrl(START_URL);
        else webView.restoreState(savedInstanceState);
    }

    private void hideSystemBars() {
        WindowInsetsController c = getWindow().getInsetsController();
        if (c != null) {
            c.hide(WindowInsets.Type.systemBars());
            c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    protected void onPause() {
        callJs("window.onAndroidPause && window.onAndroidPause()");
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        callJs("window.onAndroidResume && window.onAndroidResume()");
    }

    private void callJs(String code) {
        if (webView != null) webView.post(() -> webView.evaluateJavascript(code, null));
    }

    /** Funzioni native chiamabili dalla pagina come window.AndroidBridge.*. */
    private class Bridge {
        @JavascriptInterface
        public void exportFile(String fileName, String base64) {
            pendingExport = Base64.decode(base64, Base64.DEFAULT);
            runOnUiThread(() -> createDocument.launch(fileName));
        }

        /**
         * Feedback aptico dei tasti. mode 0 = vibratore (impulso con durata e intensità),
         * mode 1 = feedback aptico di sistema della vista (come la tastiera).
         * L'impulso usa la categoria "media", quella prevista per i giochi, così non dipende
         * dall'impostazione "vibrazione al tocco" del telefono.
         */
        @JavascriptInterface
        public void vibrate(int ms, int amplitude, int mode) {
            if (mode == 1) {
                runOnUiThread(() -> webView.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP));
                return;
            }
            if (vibrator == null || !vibrator.hasVibrator() || ms <= 0) return;
            int amp = vibrator.hasAmplitudeControl() ? Math.max(1, Math.min(255, amplitude)) : VibrationEffect.DEFAULT_AMPLITUDE;
            VibrationEffect effect = VibrationEffect.createOneShot(ms, amp);
            if (Build.VERSION.SDK_INT >= 33) {
                vibrator.vibrate(effect, VibrationAttributes.createForUsage(VibrationAttributes.USAGE_MEDIA));
            } else {
                vibrator.vibrate(effect);
            }
        }

        /** Informazioni per capire perché la vibrazione non si sente. */
        @JavascriptInterface
        public String vibrationInfo() {
            boolean has = vibrator != null && vibrator.hasVibrator();
            boolean amp = has && vibrator.hasAmplitudeControl();
            return "vibratore " + (has ? "sì" : "no") + ", intensità " + (amp ? "regolabile" : "fissa") + ", Android API " + Build.VERSION.SDK_INT;
        }

        @JavascriptInterface
        public String version() {
            return "0.6.0";
        }
    }

    /** Serve i file da assets/ con i MIME corretti. */
    private class AppAssetHandler implements WebViewAssetLoader.PathHandler {
        private final Map<String, String> headers = new HashMap<>();

        AppAssetHandler() {
            headers.put("Cache-Control", "no-cache");
        }

        @Override
        public WebResourceResponse handle(String path) {
            if (path.isEmpty() || path.endsWith("/")) path = path + "index.html";
            try {
                InputStream in = getAssets().open(path);
                WebResourceResponse r = new WebResourceResponse(mime(path), null, in);
                r.setStatusCodeAndReasonPhrase(200, "OK");
                r.setResponseHeaders(headers);
                return r;
            } catch (IOException e) {
                WebResourceResponse r = new WebResourceResponse("text/plain", "utf-8", null);
                r.setStatusCodeAndReasonPhrase(404, "Not Found");
                r.setResponseHeaders(headers);
                return r;
            }
        }

        private String mime(String p) {
            String l = p.toLowerCase();
            if (l.endsWith(".html")) return "text/html";
            if (l.endsWith(".js") || l.endsWith(".mjs")) return "text/javascript";
            if (l.endsWith(".css")) return "text/css";
            if (l.endsWith(".wasm")) return "application/wasm";
            if (l.endsWith(".json")) return "application/json";
            if (l.endsWith(".svg")) return "image/svg+xml";
            if (l.endsWith(".png")) return "image/png";
            if (l.endsWith(".webp")) return "image/webp";
            return "application/octet-stream";
        }
    }
}
