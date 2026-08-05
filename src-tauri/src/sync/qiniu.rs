// 七牛云 Kodo 客户端 — 使用原始 reqwest + HMAC-SHA1 签名
// 避免 qiniu-sdk 在 Tauri runtime 下的兼容性问题

use base64::Engine;
use reqwest::Client;
use serde::Deserialize;
use sha1::{Digest, Sha1};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::qiniu_config::*;

fn client() -> Client {
    Client::builder()
        .timeout(Duration::from_secs(10))
        .connect_timeout(Duration::from_secs(5))
        .build()
        .expect("failed to build reqwest client")
}

fn upload_client() -> Client {
    Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .build()
        .expect("failed to build upload reqwest client")
}

fn download_client() -> Client {
    Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .build()
        .expect("failed to build download reqwest client")
}

// ─── HMAC-SHA1 签名（手动实现，避免 hmac crate 兼容性问题） ───

fn hmac_sha1(key: &[u8], data: &[u8]) -> [u8; 20] {
    const BLOCK: usize = 64;

    let mut key_fixed = [0u8; BLOCK];
    if key.len() > BLOCK {
        let h = Sha1::digest(key);
        key_fixed[..h.len()].copy_from_slice(&h);
    } else {
        key_fixed[..key.len()].copy_from_slice(key);
    }

    let mut ipad = [0u8; BLOCK];
    let mut opad = [0u8; BLOCK];
    for i in 0..BLOCK {
        ipad[i] = key_fixed[i] ^ 0x36;
        opad[i] = key_fixed[i] ^ 0x5c;
    }

    let mut inner = Sha1::new();
    inner.update(&ipad);
    inner.update(data);
    let inner_hash = inner.finalize();

    let mut outer = Sha1::new();
    outer.update(&opad);
    outer.update(&inner_hash);
    let result = outer.finalize();

    let mut out = [0u8; 20];
    out.copy_from_slice(&result);
    out
}

fn sign(data: &[u8]) -> String {
    base64_encode(&hmac_sha1(SECRET_KEY.as_bytes(), data))
}

fn base64_encode(data: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE.encode(data)
}

// ─── 上传 Token ───

fn upload_token(key: &str) -> String {
    let deadline = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 3600;

    let put_policy = serde_json::json!({
        "scope": format!("{}:{}", &*BUCKET, key),
        "deadline": deadline,
    });
    let encoded_put_policy = base64_encode(put_policy.to_string().as_bytes());
    let signature = sign(encoded_put_policy.as_bytes());
    format!("{}:{}:{}", &*ACCESS_KEY, signature, encoded_put_policy)
}

// ─── 下载 URL 签名（私有空间） ───

fn signed_download_url(key: &str) -> String {
    let deadline = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 3600;

    let url = format!("http://{}/{}", &*DOMAIN, key);
    let to_sign = format!("{}?e={}", url, deadline);
    let signature = sign(to_sign.as_bytes());
    // token = access_key:encoded_signature
    let token = format!("{}:{}", &*ACCESS_KEY, signature);
    // URL 安全的 token 需要 encode
    format!("{}&token={}", to_sign, token)
}

// ─── 数据结构 ───

#[derive(Debug, Deserialize)]
pub struct UploadResponse {
    pub hash: String,
    pub key: String,
}

// ─── API 操作 ───

/// 上传文件
pub async fn upload(key: &str, data: &[u8]) -> Result<UploadResponse, String> {
    let token = upload_token(key);
    let file_part = reqwest::multipart::Part::bytes(data.to_vec())
        .file_name(key.to_string())
        .mime_str("application/octet-stream")
        .map_err(|e| format!("mime: {e}"))?;

    let form = reqwest::multipart::Form::new()
        .text("token", token)
        .text("key", key.to_string())
        .part("file", file_part);

    let resp = upload_client()
        .post(UPLOAD_HOST)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("upload request: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("upload http {}: {}", status, body));
    }

    let upload_resp: UploadResponse = resp.json().await.map_err(|e| format!("parse: {e}"))?;
    Ok(upload_resp)
}

/// 下载文件（私有空间）
pub async fn download(key: &str) -> Result<Vec<u8>, String> {
    let url = signed_download_url(key);
    let resp = download_client()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("download request: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!(
            "download http {}: {}",
            resp.status(),
            resp.text().await.unwrap_or_default()
        ));
    }

    resp.bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| format!("download read: {e}"))
}

/// 检查文件是否存在
pub async fn stat(key: &str) -> Result<Option<serde_json::Value>, String> {
    let encoded_entry = base64_encode(format!("{}:{}", &*BUCKET, key).as_bytes());
    let path = format!("/stat/{}", encoded_entry);
    let url = format!("http://rs.qiniuapi.com{}", path);
    let auth_header = qbox_auth(&path, "");

    let resp = client()
        .get(&url)
        .header("Authorization", &auth_header)
        .send()
        .await
        .map_err(|e| format!("stat request: {e}"))?;

    if !resp.status().is_success() {
        if resp.status().as_u16() == 612 {
            return Ok(None);
        }
        return Err(format!("stat http {}: {}", resp.status(), resp.text().await.unwrap_or_default()));
    }

    let json: serde_json::Value = resp.json().await.map_err(|e| format!("parse: {e}"))?;
    Ok(Some(json))
}

/// 删除文件
pub async fn delete(key: &str) -> Result<(), String> {
    let encoded_entry = base64_encode(format!("{}:{}", &*BUCKET, key).as_bytes());
    let path = format!("/delete/{}", encoded_entry);
    let url = format!("http://rs.qiniuapi.com{}", path);
    let auth_header = qbox_auth(&path, "");

    let resp = client()
        .post(&url)
        .header("Authorization", &auth_header)
        .send()
        .await
        .map_err(|e| format!("delete request: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("delete http {}", resp.status()));
    }
    Ok(())
}

/// 按前缀列出文件
pub async fn list_prefix(prefix: &str) -> Result<Vec<serde_json::Value>, String> {
    let params = format!(
        "bucket={}&prefix={}&limit=1000",
        &*BUCKET,
        urlencoding::encode(prefix)
    );
    let path = format!("/list?{}", params);
    let url = format!("http://rsf.qiniuapi.com{}", path);
    let auth_header = qbox_auth(&path, "");

    let resp = client()
        .get(&url)
        .header("Authorization", &auth_header)
        .send()
        .await
        .map_err(|e| format!("list request: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!(
            "list http {}: {}",
            resp.status(),
            resp.text().await.unwrap_or_default()
        ));
    }

    let json: serde_json::Value = resp.json().await.map_err(|e| format!("parse: {e}"))?;
    let items = json["items"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    Ok(items)
}

/// 生成下载 URL（公开访问，无需签名）
pub fn make_download_url(key: &str) -> String {
    format!("http://{}/{}", &*DOMAIN, key)
}

// ─── QBox 管理认证 ───

fn qbox_auth(path: &str, body: &str) -> String {
    let to_sign = format!("{}\n{}", path, body);
    let signature = sign(to_sign.as_bytes());
    format!("QBox {}:{}", &*ACCESS_KEY, signature)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_check_sunsh_qiniu_data() {
        // 检查用户 sunsh 在七牛云上的数据
        let prefix = "xiaoya-ai/users/";
        println!("=== 检查七牛云 xiaoya-ai/users/ 目录 ===");
        match list_prefix(prefix).await {
            Ok(items) => {
                println!("找到 {} 个条目:", items.len());
                for item in &items {
                    let key = item["key"].as_str().unwrap_or("?");
                    let size = item["fsize"].as_u64().unwrap_or(0);
                    let mime = item["mimeType"].as_str().unwrap_or("?");
                    println!("  {} ({} bytes, {})", key, size, mime);
                }
                if items.is_empty() {
                    println!("  (空目录)");
                }
            }
            Err(e) => println!("列出失败: {}", e),
        }

        // 也检查旧的 xiaoya-ai 前缀
        let prefix2 = "xiaoya-ai/";
        println!("\n=== 检查旧 xiaoya-ai/ 目录 ===");
        match list_prefix(prefix2).await {
            Ok(items) => {
                for item in &items {
                    let key = item["key"].as_str().unwrap_or("?");
                    let size = item["fsize"].as_u64().unwrap_or(0);
                    println!("  {} ({} bytes)", key, size);
                }
                if items.is_empty() {
                    println!("  (空目录)");
                }
            }
            Err(e) => println!("列出失败: {}", e),
        }

        // 检查 sunsh 用户
        let sunsh_prefix = "xiaoya-ai/users/sunsh/";
        println!("\n=== 检查 sunsh 用户数据 ({}) ===", sunsh_prefix);
        match list_prefix(sunsh_prefix).await {
            Ok(items) => {
                for item in &items {
                    let key = item["key"].as_str().unwrap_or("?");
                    let size = item["fsize"].as_u64().unwrap_or(0);
                    println!("  {} ({} bytes)", key, size);
                }
                if items.is_empty() {
                    println!("  (空目录 — 无此用户数据)");
                }
            }
            Err(e) => println!("列出失败: {}", e),
        }
    }

    #[test]
    fn test_hmac_sha1_known_vector() {
        // RFC 2202 / RFC 4231 test vectors
        // key="key", data="The quick brown fox jumps over the lazy dog"
        let key = b"key";
        let data = b"The quick brown fox jumps over the lazy dog";
        let result = hmac_sha1(key, data);
        let hex = result.iter().map(|b| format!("{:02x}", b)).collect::<Vec<_>>().join("");
        // Expected: de7c9b85b8b78aa6bc8a7a36f70a90701c9db4d9
        assert_eq!(hex, "de7c9b85b8b78aa6bc8a7a36f70a90701c9db4d9", "HMAC-SHA1 test vector failed, got {}", hex);

        // Another vector: key="", data=""
        let result2 = hmac_sha1(b"", b"");
        let hex2 = result2.iter().map(|b| format!("{:02x}", b)).collect::<Vec<_>>().join("");
        // Expected: fbdb1d1b18aa6c08324b7d64b71fb76370690e1d
        assert_eq!(hex2, "fbdb1d1b18aa6c08324b7d64b71fb76370690e1d", "HMAC-SHA1 empty vector failed, got {}", hex2);
    }

    #[test]
    fn test_token_format() {
        let test_key = "test/debug_token.json";
        let deadline = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 3600;

        let put_policy = serde_json::json!({
            "scope": format!("{}:{}", &*BUCKET, test_key),
            "deadline": deadline,
        });
        let pp_str = put_policy.to_string();
        println!("put_policy JSON: {}", pp_str);

        let encoded_pp = base64_encode(pp_str.as_bytes());
        println!("encoded_put_policy: {}", encoded_pp);

        let signature = sign(encoded_pp.as_bytes());
        println!("signature: {}", signature);

        let token = format!("{}:{}:{}", &*ACCESS_KEY, signature, encoded_pp);
        println!("token: {}", token);
    }

    #[tokio::test]
    async fn test_upload_download_delete() {
        let test_key = "test/raw_http_test.json";
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let test_data = format!("raw http test at {}", ts);

        // 上传
        let up = upload(test_key, test_data.as_bytes()).await;
        assert!(up.is_ok(), "上传失败: {:?}", up.err());
        println!("上传成功: {:?}", up.unwrap());

        // 下载验证
        let down = download(test_key).await;
        assert!(down.is_ok(), "下载失败: {:?}", down.err());
        assert_eq!(down.unwrap(), test_data.as_bytes(), "数据不一致");

        // 清理
        let del = delete(test_key).await;
        assert!(del.is_ok(), "删除失败: {:?}", del.err());

        println!("原始 HTTP 七牛云测试全部通过！");
    }
}
