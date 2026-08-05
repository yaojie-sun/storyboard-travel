use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashMap;

fn deserialize_chat_map<'de, D>(deserializer: D) -> Result<HashMap<String, FileEntry>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    match value {
        serde_json::Value::Null => Ok(HashMap::new()),
        serde_json::Value::Object(map) => {
            // 旧格式：{"hash":"...","size":123} → 用 _legacy 占位
            if map.contains_key("hash") && map.contains_key("size") && !map.contains_key("_marker") {
                let entry: FileEntry = serde_json::from_value(serde_json::Value::Object(map))
                    .map_err(serde::de::Error::custom)?;
                let mut result = HashMap::new();
                result.insert("_legacy".to_string(), entry);
                Ok(result)
            } else {
                let mut result = HashMap::new();
                for (k, v) in map {
                    let entry: FileEntry = serde_json::from_value(v)
                        .map_err(serde::de::Error::custom)?;
                    result.insert(k, entry);
                }
                Ok(result)
            }
        }
        _ => Ok(HashMap::new()),
    }
}

/// 远端清单，记录每个数据对象的版本与 hash
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SyncManifest {
    pub db: Option<FileEntry>,
    pub images: HashMap<String, FileEntry>,
    pub assets: HashMap<String, FileEntry>,
    #[serde(default, deserialize_with = "deserialize_chat_map")]
    pub chat: HashMap<String, FileEntry>,
    pub settings: Option<FileEntry>,
    pub globals: HashMap<String, FileEntry>,
    pub videos: HashMap<String, FileEntry>,
    pub videogen_store: Option<FileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub hash: String,
    pub size: u64,
}

/// 差异清单
#[derive(Debug, Default)]
pub struct SyncDiff {
    pub db_needs_sync: bool,
    pub images_to_upload: Vec<String>,   // md5.ext
    pub images_to_download: Vec<String>, // md5.ext
    pub assets_to_upload: Vec<String>,   // full path key
    pub assets_to_download: Vec<String>, // full path key
    pub chat_to_upload: Vec<String>,     // project_id
    pub chat_to_download: Vec<String>,   // project_id
    pub settings_needs_sync: bool,
    pub settings_direction: Option<SyncDirection>,
    pub globals_to_upload: Vec<String>,   // project_id
    pub globals_to_download: Vec<String>, // project_id
    pub videos_to_upload: Vec<String>,
    pub videos_to_download: Vec<String>,
    pub videogen_store_needs_sync: bool,
    pub videogen_store_direction: Option<SyncDirection>,
}

#[derive(Debug, PartialEq)]
pub enum SyncDirection {
    Upload,
    Download,
}

impl SyncManifest {
    /// 对比本地与远端清单，返回差异
    pub fn compare(local: &Self, remote: &Self) -> SyncDiff {
        let mut diff = SyncDiff::default();

        // db
        diff.db_needs_sync = match (&local.db, &remote.db) {
            (Some(l), Some(r)) => l.hash != r.hash,
            (Some(_), None) => true,
            (None, Some(_)) => true,
            (None, None) => false,
        };

        // images — 以本地为准，本地有远端无则上传，远端有本地无则下载
        for (key, entry) in &local.images {
            match remote.images.get(key) {
                Some(r) if r.hash == entry.hash => {}
                _ => diff.images_to_upload.push(key.clone()),
            }
        }
        for key in remote.images.keys() {
            if !local.images.contains_key(key) {
                diff.images_to_download.push(key.clone());
            }
        }

        // assets
        for (key, entry) in &local.assets {
            match remote.assets.get(key) {
                Some(r) if r.hash == entry.hash => {}
                _ => diff.assets_to_upload.push(key.clone()),
            }
        }
        for key in remote.assets.keys() {
            if !local.assets.contains_key(key) {
                diff.assets_to_download.push(key.clone());
            }
        }

        // chat — per-project files，与 globals 同模式
        for (key, entry) in &local.chat {
            match remote.chat.get(key) {
                Some(r) if r.hash == entry.hash => {}
                _ => diff.chat_to_upload.push(key.clone()),
            }
        }
        for key in remote.chat.keys() {
            if !local.chat.contains_key(key) {
                diff.chat_to_download.push(key.clone());
            }
        }

        // settings
        diff.settings_needs_sync = match (&local.settings, &remote.settings) {
            (Some(l), Some(r)) => l.hash != r.hash,
            (Some(_), None) => {
                diff.settings_direction = Some(SyncDirection::Upload);
                true
            }
            (None, Some(_)) => {
                diff.settings_direction = Some(SyncDirection::Download);
                true
            }
            (None, None) => false,
        };

        // globals
        for (key, entry) in &local.globals {
            match remote.globals.get(key) {
                Some(r) if r.hash == entry.hash => {}
                _ => diff.globals_to_upload.push(key.clone()),
            }
        }
        for key in remote.globals.keys() {
            if !local.globals.contains_key(key) {
                diff.globals_to_download.push(key.clone());
            }
        }

        // videos
        for (key, entry) in &local.videos {
            match remote.videos.get(key) {
                Some(r) if r.hash == entry.hash => {}
                _ => diff.videos_to_upload.push(key.clone()),
            }
        }
        for key in remote.videos.keys() {
            if !local.videos.contains_key(key) {
                diff.videos_to_download.push(key.clone());
            }
        }

        // videogen_store
        diff.videogen_store_needs_sync = match (&local.videogen_store, &remote.videogen_store) {
            (Some(l), Some(r)) => l.hash != r.hash,
            (Some(_), None) => {
                diff.videogen_store_direction = Some(SyncDirection::Upload);
                true
            }
            (None, Some(_)) => {
                diff.videogen_store_direction = Some(SyncDirection::Download);
                true
            }
            (None, None) => false,
        };

        diff
    }

    pub fn compute_hash(data: &[u8]) -> String {
        use sha1::{Digest, Sha1};
        let mut hasher = Sha1::new();
        hasher.update(data);
        format!("{:x}", hasher.finalize())
    }
}

/// Check if diff is empty
pub fn diff_is_empty(diff: &SyncDiff) -> bool {
    !diff.db_needs_sync
        && diff.images_to_upload.is_empty()
        && diff.images_to_download.is_empty()
        && diff.assets_to_upload.is_empty()
        && diff.assets_to_download.is_empty()
        && diff.chat_to_upload.is_empty()
        && diff.chat_to_download.is_empty()
        && !diff.settings_needs_sync
        && diff.globals_to_upload.is_empty()
        && diff.globals_to_download.is_empty()
        && diff.videos_to_upload.is_empty()
        && diff.videos_to_download.is_empty()
        && !diff.videogen_store_needs_sync
}
