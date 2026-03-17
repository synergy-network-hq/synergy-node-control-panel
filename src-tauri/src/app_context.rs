use std::path::PathBuf;

#[derive(Debug, Clone, Default)]
pub struct AppContext {
    resource_roots: Vec<PathBuf>,
    app_data_dir: Option<PathBuf>,
}

impl AppContext {
    pub fn from_env() -> Self {
        let mut resource_roots = Vec::new();

        if let Some(root) = std::env::var_os("SYNERGY_RESOURCE_ROOT") {
            resource_roots.push(PathBuf::from(root));
        }

        if let Ok(current_dir) = std::env::current_dir() {
            resource_roots.push(current_dir.clone());
            for ancestor in current_dir.ancestors().take(8) {
                resource_roots.push(ancestor.to_path_buf());
            }
        }

        Self {
            resource_roots: dedupe_paths(resource_roots),
            app_data_dir: std::env::var_os("SYNERGY_APP_DATA_DIR").map(PathBuf::from),
        }
    }

    #[cfg(feature = "desktop-native-shell")]
    pub fn from_desktop_shell(app_handle: &tauri::AppHandle) -> Self {
        use tauri::Manager;

        let mut resource_roots = Vec::new();

        if let Ok(resource_dir) = app_handle.path().resource_dir() {
            resource_roots.push(resource_dir.clone());
            resource_roots.push(resource_dir.join("_up_"));
            resource_roots.push(resource_dir.join("_up_/_up_/_up_"));
        }

        if let Ok(executable) = std::env::current_exe() {
            if let Some(exe_dir) = executable.parent() {
                resource_roots.push(exe_dir.to_path_buf());
                resource_roots.push(exe_dir.join("../Resources"));
                resource_roots.push(exe_dir.join("../Resources/_up_/_up_/_up_"));
            }
        }

        if let Ok(current_dir) = std::env::current_dir() {
            resource_roots.push(current_dir.clone());
            for ancestor in current_dir.ancestors().take(8) {
                resource_roots.push(ancestor.to_path_buf());
            }
        }

        Self {
            resource_roots: dedupe_paths(resource_roots),
            app_data_dir: app_handle.path().app_data_dir().ok(),
        }
    }

    pub fn resource_roots(&self) -> &[PathBuf] {
        &self.resource_roots
    }

    pub fn app_data_dir(&self) -> Option<&PathBuf> {
        self.app_data_dir.as_ref()
    }
}

fn dedupe_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut output = Vec::new();
    for path in paths {
        if output.iter().any(|existing| existing == &path) {
            continue;
        }
        output.push(path);
    }
    output
}
