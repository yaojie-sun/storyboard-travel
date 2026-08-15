use std::sync::Arc;

use super::AIProvider;

pub mod baidu;
pub mod grsai;
pub mod happyhorse;
pub mod kie;
pub mod pixverse;
pub mod ppio;
pub mod volcengine;

pub use baidu::BaiduProvider;
pub use grsai::GrsaiProvider;
pub use happyhorse::HappyHorseProvider;
pub use kie::KieProvider;
pub use pixverse::PixVerseProvider;
pub use ppio::PPIOProvider;
pub use volcengine::VolcengineProvider;

pub fn build_default_providers() -> Vec<Arc<dyn AIProvider>> {
    vec![
        Arc::new(BaiduProvider::new()),
        Arc::new(PPIOProvider::new()),
        Arc::new(GrsaiProvider::new()),
        Arc::new(VolcengineProvider::new()),
        Arc::new(HappyHorseProvider::new()),
        Arc::new(PixVerseProvider::new()),
        Arc::new(KieProvider::new()),
    ]
}
