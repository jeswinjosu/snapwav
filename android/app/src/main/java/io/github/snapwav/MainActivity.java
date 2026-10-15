/*
 * SnapWav — Android wrapper
 * Copyright (C) 2026 SnapWav contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * A single WebView that runs the bundled web app (assets/www) from a private secure origin,
 * plus a small bridge for things browsers can't do inside an app: saving exports with the
 * system "Save to…" picker, receiving shared audio files, keeping the screen on, and haptics.
 * Plain Android framework APIs only (no AndroidX), compatible with Java 8 bytecode.
 */
package io.github.snapwav;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.res.Configuration;
import android.graphics.Color;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Parcelable;
import android.os.Vibrator;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public class MainActivity extends Activity {
    private static final String TAG = "SnapWav";
    /* Reserved host for app-local content (same idea as AndroidX WebViewAssetLoader) */
    static final String HOST = "appassets.androidplatform.net";
    static final String ORIGIN = "https://" + HOST;
    static final int REQ_FILES = 41;
    static final int REQ_SAVE = 42;
    static final int BG_DARK = 0xFF0F0F11;
    static final int BG_LIGHT = 0xFFF4F4F5;

    WebView web;
    ValueCallback<Uri[]> fileCallback;
    final Map<String, Uri> shared = Collections.synchronizedMap(new HashMap<String, Uri>());
    final List<JSONObject> pendingShared = new ArrayList<JSONObject>();
    volatile boolean jsReady = false;
    final Handler ui = new Handler(Looper.getMainLooper());

    /* One export at a time: JS streams base64 chunks into a cache file, then we ask where to save it */
    String saveToken;
    File saveTemp;
    String saveName;
    String saveMime;
    FileOutputStream saveOut;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        boolean night = isNight();
        applyBars(night ? BG_DARK : BG_LIGHT, !night);

        web = new WebView(this);
        web.setBackgroundColor(night ? BG_DARK : BG_LIGHT);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        setContentView(web);

        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(false);
        s.setUserAgentString(s.getUserAgentString() + " SnapWavAndroid/" + versionName());

        web.addJavascriptInterface(new Bridge(), "SnapWavAndroid");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());

        handleIntent(getIntent());
        web.loadUrl(ORIGIN + "/index.html");
    }

    /* The phone's dark-theme setting (used when SnapWav's Appearance is "System") */
    boolean isNight() {
        return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
    }

    /* Status and navigation bar colour, with dark icons on light bars */
    @SuppressWarnings("deprecation")
    void applyBars(int color, boolean light) {
        Window w = getWindow();
        w.setStatusBarColor(color);
        w.setNavigationBarColor(color);
        View d = w.getDecorView();
        int flags = d.getSystemUiVisibility();
        if (Build.VERSION.SDK_INT >= 23) flags = light ? (flags | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR) : (flags & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        if (Build.VERSION.SDK_INT >= 26) flags = light ? (flags | 0x10) : (flags & ~0x10);   // SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        d.setSystemUiVisibility(flags);
        if (web != null) web.setBackgroundColor(color);
    }

    @Override
    public void onConfigurationChanged(Configuration c) {
        super.onConfigurationChanged(c);
        if (web != null) web.evaluateJavascript("window.snapwavSystemTheme&&window.snapwavSystemTheme(" + isNight() + ")", null);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    @Override
    public void onBackPressed() {
        // The web app pushes history entries for open sheets and sections, so Back closes those first.
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.removeJavascriptInterface("SnapWavAndroid");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    String versionName() {
        try {
            PackageInfo p = getPackageManager().getPackageInfo(getPackageName(), 0);
            return p.versionName;
        } catch (Exception e) {
            return "1";
        }
    }

    /* ---------- Shared / opened files ---------- */
    void handleIntent(Intent it) {
        if (it == null) return;
        String action = it.getAction();
        List<Uri> uris = new ArrayList<Uri>();
        if (Intent.ACTION_SEND.equals(action)) {
            Parcelable p = it.getParcelableExtra(Intent.EXTRA_STREAM);
            if (p instanceof Uri) uris.add((Uri) p);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Parcelable> list = it.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) for (Parcelable p : list) if (p instanceof Uri) uris.add((Uri) p);
        } else if (Intent.ACTION_VIEW.equals(action) && it.getData() != null) {
            uris.add(it.getData());
        }
        if (uris.isEmpty() && (Intent.ACTION_SEND.equals(action) || Intent.ACTION_SEND_MULTIPLE.equals(action))) {
            ClipData cd = it.getClipData();
            if (cd != null) for (int i = 0; i < cd.getItemCount(); i++) if (cd.getItemAt(i).getUri() != null) uris.add(cd.getItemAt(i).getUri());
        }
        if (uris.isEmpty()) return;
        synchronized (pendingShared) {
            for (Uri u : uris) {
                String id = UUID.randomUUID().toString();
                shared.put(id, u);
                try {
                    JSONObject o = new JSONObject();
                    o.put("url", ORIGIN + "/__shared/" + id);
                    o.put("name", displayName(u));
                    String type = getContentResolver().getType(u);
                    o.put("type", type == null ? "" : type);
                    pendingShared.add(o);
                } catch (JSONException e) {
                    Log.w(TAG, e);
                }
            }
        }
        it.setAction(Intent.ACTION_MAIN);
        deliverShared();
    }

    String drainShared() {
        synchronized (pendingShared) {
            JSONArray a = new JSONArray();
            for (JSONObject o : pendingShared) a.put(o);
            pendingShared.clear();
            return a.toString();
        }
    }

    void deliverShared() {
        if (!jsReady || web == null) return;
        final String json = drainShared();
        if ("[]".equals(json)) return;
        ui.post(new Runnable() {
            public void run() {
                if (web != null) web.evaluateJavascript("window.snapwavReceive&&window.snapwavReceive(" + json + ")", null);
            }
        });
    }

    String displayName(Uri u) {
        String name = null;
        Cursor c = null;
        try {
            c = getContentResolver().query(u, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null);
            if (c != null && c.moveToFirst()) name = c.getString(0);
        } catch (Exception e) {
            Log.w(TAG, "name lookup failed", e);
        } finally {
            if (c != null) c.close();
        }
        if (name == null) name = u.getLastPathSegment();
        return name == null ? "shared-audio" : name;
    }

    /* ---------- Serving the app ---------- */
    static String mimeFor(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js")) return "application/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json") || p.endsWith(".webmanifest")) return "application/json";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".woff2")) return "font/woff2";
        if (p.endsWith(".txt")) return "text/plain";
        return "application/octet-stream";
    }

    static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", new HashMap<String, String>(), new ByteArrayInputStream(new byte[0]));
    }

    class Client extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (!HOST.equals(u.getHost())) return null;
            String path = u.getPath();
            if (path == null || path.length() == 0 || "/".equals(path)) path = "/index.html";
            Map<String, String> headers = new HashMap<String, String>();
            try {
                if (path.startsWith("/__shared/")) {
                    Uri src = shared.get(path.substring("/__shared/".length()));
                    if (src == null) return notFound();
                    InputStream in = getContentResolver().openInputStream(src);
                    if (in == null) return notFound();
                    String type = getContentResolver().getType(src);
                    headers.put("Cache-Control", "no-store");
                    return new WebResourceResponse(type == null ? "application/octet-stream" : type, null, 200, "OK", headers, in);
                }
                if (path.contains("..")) return notFound();
                InputStream in = getAssets().open("www" + path);
                String mime = mimeFor(path);
                headers.put("Cache-Control", "no-cache");
                boolean text = mime.startsWith("text/") || mime.contains("javascript") || mime.contains("json") || mime.contains("svg");
                return new WebResourceResponse(mime, text ? "utf-8" : null, 200, "OK", headers, in);
            } catch (Exception e) {
                return notFound();
            }
        }

        /* API 24+ overload (no @Override so the class also compiles against older platform jars) */
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            return openExternal(req.getUrl());
        }

        @Override
        @SuppressWarnings("deprecation")
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return openExternal(Uri.parse(url));
        }

        boolean openExternal(Uri u) {
            if (HOST.equals(u.getHost())) return false;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, u));
            } catch (ActivityNotFoundException e) {
                Log.w(TAG, "no app for " + u);
            }
            return true;
        }
    }

    class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            boolean audio = false;
            String[] accept = params.getAcceptTypes();
            if (accept != null) for (String t : accept) if (t != null && t.contains("audio")) audio = true;
            Intent i = new Intent(Intent.ACTION_GET_CONTENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            if (audio) {
                i.setType("audio/*");
                i.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"audio/*", "application/ogg", "video/mp4", "video/webm"});
            } else {
                i.setType("*/*");
            }
            i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
            try {
                startActivityForResult(i, REQ_FILES);
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                return false;
            }
            return true;
        }

        @Override
        public boolean onConsoleMessage(ConsoleMessage m) {
            Log.d(TAG, m.message() + " (" + m.sourceId() + ":" + m.lineNumber() + ")");
            return true;
        }
    }

    @Override
    protected void onActivityResult(int req, int code, Intent data) {
        if (req == REQ_FILES) {
            if (fileCallback == null) return;
            Uri[] result = null;
            if (code == RESULT_OK && data != null) {
                ClipData cd = data.getClipData();
                if (cd != null && cd.getItemCount() > 0) {
                    result = new Uri[cd.getItemCount()];
                    for (int i = 0; i < cd.getItemCount(); i++) result[i] = cd.getItemAt(i).getUri();
                } else if (data.getData() != null) {
                    result = new Uri[]{data.getData()};
                }
            }
            fileCallback.onReceiveValue(result);
            fileCallback = null;
            return;
        }
        if (req == REQ_SAVE) {
            final Uri dest = (code == RESULT_OK && data != null) ? data.getData() : null;
            if (dest == null) {
                finishSave(false, "cancelled");
                return;
            }
            new Thread(new Runnable() {
                public void run() {
                    InputStream in = null;
                    OutputStream out = null;
                    try {
                        in = new FileInputStream(saveTemp);
                        out = getContentResolver().openOutputStream(dest, "w");
                        if (out == null) throw new IOException("no output stream");
                        byte[] buf = new byte[65536];
                        int n;
                        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                        out.flush();
                        finishSave(true, displayName(dest));
                    } catch (Exception e) {
                        Log.w(TAG, "save failed", e);
                        finishSave(false, String.valueOf(e.getMessage()));
                    } finally {
                        try { if (in != null) in.close(); } catch (IOException ignored) { }
                        try { if (out != null) out.close(); } catch (IOException ignored) { }
                    }
                }
            }).start();
            return;
        }
        super.onActivityResult(req, code, data);
    }

    void finishSave(final boolean ok, final String msg) {
        final String token = saveToken;
        if (saveTemp != null) saveTemp.delete();
        saveTemp = null;
        saveToken = null;
        ui.post(new Runnable() {
            public void run() {
                if (web == null || token == null) return;
                web.evaluateJavascript("window.__snapwavSaveDone&&window.__snapwavSaveDone(" + JSONObject.quote(token) + "," + ok + "," + JSONObject.quote(msg == null ? "" : msg) + ")", null);
            }
        });
    }

    /* ---------- JavaScript bridge: window.SnapWavAndroid ---------- */
    class Bridge {
        @JavascriptInterface
        public String takeShared() {
            jsReady = true;
            return drainShared();
        }

        @JavascriptInterface
        public String info() {
            return "{\"platform\":\"android\",\"sdk\":" + Build.VERSION.SDK_INT + ",\"version\":" + JSONObject.quote(versionName()) + ",\"night\":" + isNight() + "}";
        }

        @JavascriptInterface
        public void setBars(final String color, final boolean light) {
            ui.post(new Runnable() {
                public void run() {
                    try { applyBars(Color.parseColor(color), light); } catch (IllegalArgumentException ignored) { }
                }
            });
        }

        @JavascriptInterface
        public String saveBegin(String name, String mime) throws IOException {
            if (saveOut != null) try { saveOut.close(); } catch (IOException ignored) { }
            if (saveTemp != null) saveTemp.delete();
            saveToken = UUID.randomUUID().toString();
            saveTemp = new File(getCacheDir(), "export-" + saveToken);
            saveOut = new FileOutputStream(saveTemp);
            saveName = name == null || name.length() == 0 ? "snapwav-export" : name;
            saveMime = mime == null || mime.length() == 0 ? "application/octet-stream" : mime;
            return saveToken;
        }

        @JavascriptInterface
        public void saveChunk(String token, String b64) throws IOException {
            if (token == null || !token.equals(saveToken) || saveOut == null) return;
            saveOut.write(Base64.decode(b64, Base64.DEFAULT));
        }

        @JavascriptInterface
        public void saveEnd(String token) {
            if (token == null || !token.equals(saveToken)) return;
            try {
                if (saveOut != null) saveOut.close();
            } catch (IOException e) {
                finishSave(false, e.getMessage());
                return;
            }
            saveOut = null;
            ui.post(new Runnable() {
                public void run() {
                    Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType(saveMime);
                    i.putExtra(Intent.EXTRA_TITLE, saveName);
                    try {
                        startActivityForResult(i, REQ_SAVE);
                    } catch (ActivityNotFoundException e) {
                        finishSave(false, "no file picker available");
                    }
                }
            });
        }

        @JavascriptInterface
        public void keepScreenOn(final boolean on) {
            ui.post(new Runnable() {
                public void run() {
                    if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            });
        }

        @JavascriptInterface
        @SuppressWarnings("deprecation")
        public void vibrate(int ms) {
            try {
                Vibrator v = (Vibrator) getSystemService(VIBRATOR_SERVICE);
                if (v != null && v.hasVibrator()) v.vibrate(Math.max(1, Math.min(ms, 80)));
            } catch (Exception ignored) { }
        }
    }
}
