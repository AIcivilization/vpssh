package io.github.aicivilization.vpssh;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.SslErrorHandler;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import com.google.zxing.integration.android.IntentIntegrator;
import com.google.zxing.integration.android.IntentResult;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.cert.X509Certificate;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.net.ssl.HttpsURLConnection;

/**
 * vpssh 安卓版：一个窗口，两张网页。
 *   home：App 自带的本地页面（assets/home），管理服务器列表、扫码添加。只有它能调 App 的接口
 *   web ：服务器上的 vpssh。用 IP 访问时只信任二维码里那张根证书（Pinning）；不给它任何 App 接口
 * 返回键：网页能后退就后退，退到头回服务器列表；在列表页再按就退出。
 */
public class MainActivity extends Activity {
    private static final int REQ_FILE = 41;
    private static final String HOME = "file:///android_asset/home/index.html";

    private WebView home;
    private WebView web;
    private Servers servers;
    private String currentId = "";
    private ValueCallback<Uri[]> fileCallback;
    private final ExecutorService io = Executors.newCachedThreadPool();
    private final Handler ui = new Handler(Looper.getMainLooper());
    /** 验过的网站证书指纹（host:port → sha256）：Caddy 每 12 小时左右换一次网站证书，换了再验一次 */
    private final Map<String, String> verified = new ConcurrentHashMap<>();
    /** 新版本（Update.check 查到的）；没有就是 null */
    private volatile JSONObject update;
    private long updateCheckedAt;

    static boolean zh() {
        return Locale.getDefault().getLanguage().startsWith("zh");
    }

    static String t(String zh, String en) {
        return zh() ? zh : en;
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.parseColor("#0f1115"));
        getWindow().setNavigationBarColor(Color.parseColor("#0f1115"));
        servers = new Servers(this);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0f1115"));
        home = new WebView(this);
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(home, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        // Android 15 起应用一律铺满全屏（状态栏、底部手势条下面也画）：给内容留出这两块
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            android.graphics.Insets bars = insets.getInsets(android.view.WindowInsets.Type.systemBars() | android.view.WindowInsets.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return android.view.WindowInsets.CONSUMED;
        });

        // —— 本地页面：服务器列表 ——
        WebSettings hs = home.getSettings();
        hs.setJavaScriptEnabled(true);
        hs.setAllowFileAccess(false);
        hs.setAllowContentAccess(false);
        home.setBackgroundColor(Color.parseColor("#0f1115"));
        home.addJavascriptInterface(new Bridge(), "vpsshApp");
        home.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // 本地页面里的外部链接（GitHub 等）交给浏览器
                openExternal(request.getUrl());
                return true;
            }
        });

        // —— 服务器上的 vpssh ——
        WebSettings ws = web.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setAllowFileAccess(false);
        ws.setAllowContentAccess(false);
        ws.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        ws.setUserAgentString(ws.getUserAgentString() + " vpssh-android/" + BuildConfig.VERSION_NAME);
        web.setBackgroundColor(Color.parseColor("#0f1115"));
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        web.setWebViewClient(new ServerClient());
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), REQ_FILE);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });
        web.setDownloadListener((url, userAgent, disposition, mime, length) -> download(url, userAgent, disposition, mime));

        home.loadUrl(HOME);
        String last = servers.lastId();
        if (!last.isEmpty() && servers.get(last) != null) open(last);
        else showHome();
    }

    // —— 本地页面能调的接口（只挂在 home 上；服务器上的网页拿不到）——
    final class Bridge {
        @JavascriptInterface
        public String lang() {
            return zh() ? "zh" : "en";
        }

        @JavascriptInterface
        public String version() {
            return BuildConfig.VERSION_NAME;
        }

        @JavascriptInterface
        public String list() {
            return servers.all().toString();
        }

        /** 添加：text 可以是扫到的二维码、粘贴的链接，或手填的地址。返回 {ok,id} 或 {error} */
        @JavascriptInterface
        public String add(String text) {
            try {
                JSONObject parsed = parseLink(text);
                if (parsed.has("error")) return parsed.toString();
                JSONObject s = servers.put(parsed.getString("url"), parsed.getString("name"), parsed.optString("ca", ""));
                return new JSONObject().put("ok", true).put("id", s.getString("id")).toString();
            } catch (Exception e) {
                return "{\"error\":" + JSONObject.quote(String.valueOf(e.getMessage())) + "}";
            }
        }

        @JavascriptInterface
        public void remove(String id) {
            servers.remove(id);
        }

        @JavascriptInterface
        public void open(String id) {
            ui.post(() -> MainActivity.this.open(id));
        }

        @JavascriptInterface
        public void scan() {
            ui.post(() -> {
                IntentIntegrator scanner = new IntentIntegrator(MainActivity.this);
                scanner.setDesiredBarcodeFormats(IntentIntegrator.QR_CODE);
                scanner.setPrompt(t("扫电脑上「VPS 管理 → 手机、平板」里的二维码", "Scan the code under VPS Manager → Phone and tablet on your computer"));
                scanner.setBeepEnabled(false);
                scanner.setOrientationLocked(false);
                scanner.initiateScan();
            });
        }

        @JavascriptInterface
        public String update() {
            JSONObject u = update;
            return u == null ? "" : u.toString();
        }

        @JavascriptInterface
        public void openUrl(String url) {
            ui.post(() -> openExternal(Uri.parse(url)));
        }
    }

    /**
     * 解析地址：https://主机[:端口]/[#vpssh-ca=<sha256>]。没写协议当成 https。
     * 用 IP（自签证书）又没有指纹：不收——让用户扫码，别靠「信任这张证书吗」这种点一下就过的确认
     */
    static JSONObject parseLink(String text) throws Exception {
        String raw = text == null ? "" : text.trim();
        if (raw.isEmpty()) return new JSONObject().put("error", t("没有内容", "Nothing to add"));
        if (!raw.matches("(?i)^https?://.*")) raw = "https://" + raw;
        Uri u = Uri.parse(raw);
        String host = u.getHost();
        if (host == null || host.isEmpty()) return new JSONObject().put("error", t("不是一个地址", "Not an address"));
        String ca = "";
        String frag = u.getFragment();
        if (frag != null) {
            for (String part : frag.split("&")) {
                if (part.startsWith("vpssh-ca=")) ca = part.substring(9).toLowerCase(Locale.ROOT);
            }
        }
        if (!ca.isEmpty() && !ca.matches("^[0-9a-f]{64}$")) return new JSONObject().put("error", t("二维码里的证书指纹不对", "The certificate fingerprint in the code is invalid"));
        boolean ip = host.matches("^[0-9.]+$") || host.contains(":");
        if (ip && ca.isEmpty()) {
            return new JSONObject().put("error", t(
                "用 IP 访问的服务器要扫码添加：在电脑上打开 vpssh →「VPS 管理 → 手机、平板」，用这个 App 扫那里的二维码（里面带着这台服务器的证书指纹）",
                "Servers reached by IP must be added by scanning: on your computer open vpssh → VPS Manager → Phone and tablet and scan that code with this app (it carries the server's certificate fingerprint)"));
        }
        String origin = "https://" + (host.contains(":") ? "[" + host + "]" : host) + (u.getPort() == -1 || u.getPort() == 443 ? "" : ":" + u.getPort());
        return new JSONObject().put("url", origin + "/").put("name", host).put("ca", ca);
    }

    // —— 新版本提醒：打开 App 时查，之后最多 6 小时查一次 ——

    @Override
    protected void onResume() {
        super.onResume();
        if (System.currentTimeMillis() - updateCheckedAt < 6 * 3_600_000L) return;
        updateCheckedAt = System.currentTimeMillis();
        io.submit(() -> {
            JSONObject u = Update.check(BuildConfig.VERSION_NAME);
            if (u == null) return;
            update = u;
            ui.post(() -> {
                home.evaluateJavascript("window.onUpdate && window.onUpdate()", null);
                // 正在用服务器上的页面：提示一下，回到服务器列表就能下载
                if (web.getVisibility() == View.VISIBLE) {
                    Toast.makeText(this, t("vpssh 有新版本 " + u.optString("latest") + "，回到服务器列表下载", "vpssh " + u.optString("latest") + " is available; go back to the server list to download it"), Toast.LENGTH_LONG).show();
                }
            });
        });
    }

    // —— 页面切换 ——

    private void showHome() {
        currentId = "";
        home.setVisibility(View.VISIBLE);
        web.setVisibility(View.INVISIBLE);
        home.evaluateJavascript("window.refresh && window.refresh()", null);
    }

    private void open(String id) {
        JSONObject s = servers.get(id);
        if (s == null) {
            showHome();
            return;
        }
        currentId = id;
        servers.setLastId(id);
        web.setVisibility(View.VISIBLE);
        home.setVisibility(View.INVISIBLE);
        String target = s.optString("url");
        if (!target.equals(web.getUrl())) web.loadUrl(target);
    }

    private void homeError(String message) {
        showHome();
        home.evaluateJavascript("window.showError && window.showError(" + JSONObject.quote(message) + ")", null);
    }

    private void openExternal(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception ignored) {
            // 没有浏览器就算了
        }
    }

    @Override
    public void onBackPressed() {
        if (web.getVisibility() == View.VISIBLE) {
            if (web.canGoBack()) web.goBack();
            else showHome();
            return;
        }
        super.onBackPressed();
    }

    // —— 服务器页面：证书、外部链接、加载失败 ——

    final class ServerClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            JSONObject s = servers.get(currentId);
            Uri target = request.getUrl();
            if (s == null) return false;
            Uri base = Uri.parse(s.optString("url"));
            boolean same = target.getHost() != null && target.getHost().equalsIgnoreCase(base.getHost()) && target.getPort() == base.getPort();
            if (same && "https".equals(target.getScheme())) return false;
            // 别的网站（GitHub 链接等）交给浏览器
            openExternal(target);
            return true;
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            Uri u = Uri.parse(error.getUrl());
            String host = u.getHost();
            int port = u.getPort() == -1 ? 443 : u.getPort();
            JSONObject s = host == null ? null : servers.byHostPort(host, port);
            String ca = s == null ? "" : s.optString("caSha256");
            X509Certificate got = error.getCertificate() == null ? null : error.getCertificate().getX509Certificate();
            if (s == null || ca.isEmpty() || got == null) {
                handler.cancel();
                homeError(t("证书不受信任：这台服务器用的是自签证书，要在 App 里扫码添加（二维码在电脑上「VPS 管理 → 手机、平板」）。用域名的话，检查证书是否正常签发。",
                    "The certificate is not trusted: this server uses a self-signed certificate, so add it by scanning the code (VPS Manager → Phone and tablet on your computer). With a domain, check that its certificate was issued."));
                return;
            }
            String key = host + ":" + port;
            io.execute(() -> {
                try {
                    String gotSha = Pinning.sha256Hex(got.getEncoded());
                    if (!gotSha.equals(verified.get(key))) {
                        String pem = s.optString("caPem");
                        if (pem.isEmpty()) {
                            pem = Pinning.fetchRoot(host, port, ca);
                            servers.setCaPem(s.getString("id"), pem);
                        }
                        String leaf = Pinning.verifiedLeaf(host, port, Pinning.parsePem(pem));
                        verified.put(key, leaf);
                    }
                    boolean ok = gotSha.equals(verified.get(key));
                    ui.post(() -> {
                        if (ok) handler.proceed();
                        else {
                            handler.cancel();
                            homeError(t("证书对不上这台服务器，已拒绝连接。", "The certificate does not belong to this server; the connection was refused."));
                        }
                    });
                } catch (Exception e) {
                    ui.post(() -> {
                        handler.cancel();
                        homeError(t("证书核对没通过（" + e.getMessage() + "）。如果服务器重装过，在电脑上重新扫一次码。",
                            "The certificate check failed (" + e.getMessage() + "). If the server was reinstalled, scan the code again."));
                    });
                }
            });
        }

        @Override
        public void onReceivedError(WebView view, android.webkit.WebResourceRequest request, android.webkit.WebResourceError error) {
            if (request.isForMainFrame()) {
                homeError(t("打不开这台服务器：" + error.getDescription() + "。检查网络、地址，以及云厂商安全组是否放行了端口。",
                    "Cannot open this server: " + error.getDescription() + ". Check the network, the address, and that the provider's security group allows the port."));
            }
        }
    }

    // —— 上传、下载 ——

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            if (fileCallback != null) fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
            return;
        }
        IntentResult scan = IntentIntegrator.parseActivityResult(requestCode, resultCode, data);
        if (scan != null) {
            String text = scan.getContents();
            if (text != null) home.evaluateJavascript("window.onScan && window.onScan(" + JSONObject.quote(text) + ")", null);
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    /** 下载：带上登录 Cookie；用 IP 的服务器照样只信任它的根证书。存到「下载」目录 */
    private void download(String url, String userAgent, String disposition, String mime) {
        String name = URLUtil.guessFileName(url, disposition, mime);
        Toast.makeText(this, t("正在下载 " + name, "Downloading " + name), Toast.LENGTH_SHORT).show();
        JSONObject s = servers.get(currentId);
        io.execute(() -> {
            try {
                HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
                String pem = s == null ? "" : s.optString("caPem");
                if (conn instanceof HttpsURLConnection && !pem.isEmpty()) {
                    ((HttpsURLConnection) conn).setSSLSocketFactory(Pinning.contextFor(Pinning.parsePem(pem)).getSocketFactory());
                    ((HttpsURLConnection) conn).setHostnameVerifier((h, ss) -> true); // 证书链已验到这台的根证书（见 Pinning）
                }
                String cookie = CookieManager.getInstance().getCookie(url);
                if (cookie != null) conn.setRequestProperty("Cookie", cookie);
                conn.setRequestProperty("User-Agent", userAgent);
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, name);
                if (mime != null) values.put(MediaStore.Downloads.MIME_TYPE, mime);
                Uri item = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                try (InputStream in = conn.getInputStream(); OutputStream out = getContentResolver().openOutputStream(item)) {
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                }
                ui.post(() -> Toast.makeText(this, t("已存到「下载」：" + name, "Saved to Downloads: " + name), Toast.LENGTH_LONG).show());
            } catch (Exception e) {
                ui.post(() -> Toast.makeText(this, t("下载失败：" + e.getMessage(), "Download failed: " + e.getMessage()), Toast.LENGTH_LONG).show());
            }
        });
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }
}
