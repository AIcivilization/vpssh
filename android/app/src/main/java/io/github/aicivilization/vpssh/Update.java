package io.github.aicivilization.vpssh;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URL;

import javax.net.ssl.HttpsURLConnection;

/**
 * 有没有新版本：看 GitHub 上 vpssh 最新的 Release。只提醒，不自己装——点「下载新版」在浏览器里下 apk，
 * 装上覆盖旧版（服务器列表、登录状态都留着；签名一致才能覆盖，见 release.yml）。
 */
final class Update {
    private Update() {}

    static final String RELEASES_API = "https://api.github.com/repos/AIcivilization/vpssh/releases/latest";
    static final String RELEASES_PAGE = "https://github.com/AIcivilization/vpssh/releases/latest";

    /** a 比 b 新返回正数；只比 主.次.补丁，带预发布后缀的当成比同号正式版旧 */
    static int compare(String a, String b) {
        String[] x = a.split("-", 2);
        String[] y = b.split("-", 2);
        String[] xs = x[0].split("\\.");
        String[] ys = y[0].split("\\.");
        for (int i = 0; i < 3; i++) {
            int p = i < xs.length ? parse(xs[i]) : 0;
            int q = i < ys.length ? parse(ys[i]) : 0;
            if (p != q) return p - q;
        }
        return (x.length > 1 ? 0 : 1) - (y.length > 1 ? 0 : 1);
    }

    private static int parse(String s) {
        try {
            return Integer.parseInt(s);
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    /** 查一次：有新版返回 {latest, url}，没有或查不到返回 null */
    static JSONObject check(String current) {
        HttpsURLConnection conn = null;
        try {
            conn = (HttpsURLConnection) new URL(RELEASES_API).openConnection();
            conn.setConnectTimeout(15_000);
            conn.setReadTimeout(15_000);
            conn.setRequestProperty("Accept", "application/vnd.github+json");
            conn.setRequestProperty("User-Agent", "vpssh-android/" + current);
            if (conn.getResponseCode() != 200) return null;
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            try (InputStream in = conn.getInputStream()) {
                byte[] chunk = new byte[8192];
                int n;
                while ((n = in.read(chunk)) > 0 && buf.size() < 1024 * 1024) buf.write(chunk, 0, n);
            }
            JSONObject body = new JSONObject(buf.toString("UTF-8"));
            String latest = body.optString("tag_name", "").replaceFirst("^v", "");
            if (!latest.matches("^\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.-]+)?$") || compare(latest, current) <= 0) return null;
            String url = body.optString("html_url", RELEASES_PAGE);
            JSONArray assets = body.optJSONArray("assets");
            if (assets != null) {
                for (int i = 0; i < assets.length(); i++) {
                    JSONObject a = assets.optJSONObject(i);
                    if (a != null && a.optString("name").endsWith("-android.apk")) url = a.optString("browser_download_url", url);
                }
            }
            return new JSONObject().put("latest", latest).put("current", current).put("url", url);
        } catch (Exception e) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }
}
