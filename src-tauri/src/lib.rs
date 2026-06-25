#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let mut builder = tauri::Builder::default();

  // 단일 인스턴스 — 딥링크가 두 번째 인스턴스를 띄우지 않도록 (데스크톱 전용)
  // 반드시 가장 먼저 등록해야 함
  #[cfg(desktop)]
  {
    builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
      // 두 번째 인스턴스 실행 시 기존 창 포커스
      use tauri::Manager;
      if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_focus();
      }
    }));
  }

  builder
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_deep_link::init())
    .setup(|app| {
      // 런타임에 noteplan:// 스킴 등록 (Windows/Linux dev에서도 동작)
      #[cfg(any(windows, target_os = "linux"))]
      {
        use tauri_plugin_deep_link::DeepLinkExt;
        let _ = app.deep_link().register_all();
      }
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
