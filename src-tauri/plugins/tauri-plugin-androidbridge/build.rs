const COMMANDS: &[&str] = &[
    "speak",
    "stopSpeak",
    "endTts",
    "updatePlayback",
    "listVoices",
    "listEngines",
    "setEngine",
    "hasAllFilesAccess",
    "requestAllFilesAccess",
    "pickFolder",
    // addPluginListener 底層走這兩個指令（事件 done/error 需要）
    "registerListener",
    "removeListener",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
