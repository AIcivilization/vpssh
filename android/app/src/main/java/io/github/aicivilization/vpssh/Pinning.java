package io.github.aicivilization.vpssh;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

/**
 * 用 IP 访问时的证书：只信任这台服务器自己的根证书（Caddy tls internal 的 CA）。
 *
 * 根证书从哪来：电脑上「VPS 管理 → 手机、平板」的二维码里有它的 SHA-256 指纹（#vpssh-ca=…）。
 * App 从服务器的 /gate/ca 取根证书，算出的指纹和二维码里的一致才收下——取的那一下不信任任何证书，
 * 但指纹对不上就丢掉，所以中间人换不了根证书。之后的每次连接，网站证书链都要验到这张根证书。
 *
 * 不核对证书上的地址：根证书只在这台服务器的 Caddy 里，它签的证书就是这台的（和别的网站共用 Caddy 时，
 * 浏览器按 IP 访问拿到的可能是签给网卡地址的那张，见 server/gate/site-block.js）。
 */
final class Pinning {
    private Pinning() {}

    static String sha256Hex(byte[] data) throws Exception {
        byte[] d = MessageDigest.getInstance("SHA-256").digest(data);
        StringBuilder sb = new StringBuilder();
        for (byte b : d) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    static X509Certificate parsePem(String pem) throws Exception {
        CertificateFactory cf = CertificateFactory.getInstance("X.509");
        return (X509Certificate) cf.generateCertificate(new ByteArrayInputStream(pem.getBytes(StandardCharsets.US_ASCII)));
    }

    /** 只信任这一张根证书的 SSLContext（下载文件也用它） */
    static SSLContext contextFor(X509Certificate root) throws Exception {
        KeyStore ks = KeyStore.getInstance(KeyStore.getDefaultType());
        ks.load(null, null);
        ks.setCertificateEntry("vpssh-root", root);
        TrustManagerFactory tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        tmf.init(ks);
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(null, tmf.getTrustManagers(), null);
        return ctx;
    }

    /** 取根证书：指纹和 expectedSha256 一致才返回 PEM，否则抛异常 */
    static String fetchRoot(String host, int port, String expectedSha256) throws Exception {
        TrustManager[] any = { new X509TrustManager() {
            public void checkClientTrusted(X509Certificate[] c, String a) {}
            public void checkServerTrusted(X509Certificate[] c, String a) {}
            public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        } };
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(null, any, null);
        HttpsURLConnection conn = (HttpsURLConnection) new URL("https", host, port, "/gate/ca").openConnection();
        conn.setSSLSocketFactory(ctx.getSocketFactory());
        conn.setHostnameVerifier((h, s) -> true);
        conn.setConnectTimeout(10_000);
        conn.setReadTimeout(10_000);
        try (InputStream in = conn.getInputStream()) {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int n;
            while ((n = in.read(chunk)) > 0 && buf.size() < 64 * 1024) buf.write(chunk, 0, n);
            String pem = new JSONObject(buf.toString("UTF-8")).getString("pem");
            String got = sha256Hex(parsePem(pem).getEncoded());
            if (!got.equalsIgnoreCase(expectedSha256)) {
                throw new SecurityException("root certificate fingerprint mismatch: " + got);
            }
            return pem;
        } finally {
            conn.disconnect();
        }
    }

    /** 连一次：证书链要验到 root。返回网站证书的 SHA-256（和 WebView 拿到的那张比对） */
    static String verifiedLeaf(String host, int port, X509Certificate root) throws Exception {
        SSLContext ctx = contextFor(root);
        try (SSLSocket socket = (SSLSocket) ctx.getSocketFactory().createSocket()) {
            socket.connect(new InetSocketAddress(host, port), 10_000);
            socket.setSoTimeout(10_000);
            socket.startHandshake(); // 验不到 root 会在这里抛
            Certificate[] chain = socket.getSession().getPeerCertificates();
            return sha256Hex(chain[0].getEncoded());
        }
    }
}
