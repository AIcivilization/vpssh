package io.github.aicivilization.vpssh;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.UUID;

/**
 * 记住的服务器：名字、访问地址、（用 IP 访问时）这台根证书的 SHA-256 指纹和根证书本身。
 * 不存密码：登录状态在 WebView 的 Cookie 里（和浏览器一样，30 天内免登录）。
 */
final class Servers {
    private static final String PREFS = "vpssh";
    private static final String KEY = "servers";
    private static final String LAST = "lastId";

    private final SharedPreferences prefs;

    Servers(Context context) {
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    synchronized JSONArray all() {
        try {
            return new JSONArray(prefs.getString(KEY, "[]"));
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    synchronized JSONObject get(String id) {
        JSONArray list = all();
        for (int i = 0; i < list.length(); i++) {
            JSONObject s = list.optJSONObject(i);
            if (s != null && id.equals(s.optString("id"))) return s;
        }
        return null;
    }

    /** 按访问地址的 host:port 找（证书出错时用） */
    synchronized JSONObject byHostPort(String host, int port) {
        JSONArray list = all();
        for (int i = 0; i < list.length(); i++) {
            JSONObject s = list.optJSONObject(i);
            if (s == null) continue;
            Uri u = Uri.parse(s.optString("url"));
            int p = u.getPort() == -1 ? 443 : u.getPort();
            if (host.equalsIgnoreCase(u.getHost()) && p == port) return s;
        }
        return null;
    }

    /** 新增或更新（同一个地址只留一条）。返回保存后的那条 */
    synchronized JSONObject put(String url, String name, String caSha256) throws JSONException {
        JSONArray list = all();
        JSONObject found = null;
        for (int i = 0; i < list.length(); i++) {
            JSONObject s = list.optJSONObject(i);
            if (s != null && url.equals(s.optString("url"))) found = s;
        }
        if (found == null) {
            found = new JSONObject();
            found.put("id", UUID.randomUUID().toString());
            found.put("addedAt", System.currentTimeMillis());
            list.put(found);
        }
        found.put("url", url);
        found.put("name", name);
        if (caSha256 != null && !caSha256.isEmpty()) {
            // 指纹换了：之前存的根证书作废，下次重新取、重新核对
            if (!caSha256.equals(found.optString("caSha256"))) found.remove("caPem");
            found.put("caSha256", caSha256);
        }
        save(list);
        return found;
    }

    synchronized void setCaPem(String id, String pem) {
        JSONArray list = all();
        for (int i = 0; i < list.length(); i++) {
            JSONObject s = list.optJSONObject(i);
            if (s != null && id.equals(s.optString("id"))) {
                try {
                    s.put("caPem", pem);
                } catch (JSONException ignored) {
                    // 存不进去下次再取
                }
            }
        }
        save(list);
    }

    synchronized void remove(String id) {
        JSONArray list = all();
        JSONArray out = new JSONArray();
        for (int i = 0; i < list.length(); i++) {
            JSONObject s = list.optJSONObject(i);
            if (s != null && !id.equals(s.optString("id"))) out.put(s);
        }
        save(out);
        if (id.equals(lastId())) prefs.edit().remove(LAST).apply();
    }

    synchronized String lastId() {
        return prefs.getString(LAST, "");
    }

    synchronized void setLastId(String id) {
        prefs.edit().putString(LAST, id).apply();
    }

    private void save(JSONArray list) {
        prefs.edit().putString(KEY, list.toString()).apply();
    }
}
