use std::sync::LazyLock;

fn get_qiniu_value(api_getter: fn() -> Option<String>, env_key: &str, _label: &str) -> String {
    // 优先从服务端下发的配置读取
    if let Some(val) = api_getter() {
        if !val.is_empty() {
            return val;
        }
    }
    // 回退到环境变量
    std::env::var(env_key).unwrap_or_else(|_| {
        eprintln!("[qiniu_config] {env_key} not set, using default: <empty>");
        String::new()
    })
}

pub static ACCESS_KEY: LazyLock<String> = LazyLock::new(|| {
    get_qiniu_value(
        crate::commands::banana_api::get_qiniu_access_key,
        "QINIU_ACCESS_KEY",
        "ACCESS_KEY",
    )
});
pub static SECRET_KEY: LazyLock<String> = LazyLock::new(|| {
    get_qiniu_value(
        crate::commands::banana_api::get_qiniu_secret_key,
        "QINIU_SECRET_KEY",
        "SECRET_KEY",
    )
});
pub static BUCKET: LazyLock<String> = LazyLock::new(|| {
    get_qiniu_value(
        crate::commands::banana_api::get_qiniu_bucket,
        "QINIU_BUCKET",
        "BUCKET",
    )
});
pub static DOMAIN: LazyLock<String> = LazyLock::new(|| {
    get_qiniu_value(
        crate::commands::banana_api::get_qiniu_domain,
        "QINIU_DOMAIN",
        "DOMAIN",
    )
});

pub const UPLOAD_HOST: &str = "https://up.qiniup.com";
