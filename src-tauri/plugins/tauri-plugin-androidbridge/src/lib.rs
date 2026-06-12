use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.comicreader.bridge";

/// Android 原生橋接：TextToSpeech 朗讀 + 所有檔案存取權限。
/// 桌面平台為 no-op（前端依平台分流，桌面走 Web Speech API）。
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("androidbridge")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            _api.register_android_plugin(PLUGIN_IDENTIFIER, "BridgePlugin")?;
            Ok(())
        })
        .build()
}
