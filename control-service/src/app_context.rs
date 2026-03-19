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
