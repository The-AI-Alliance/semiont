//! What a knowledge base says of itself: its committed project file,
//! `.semiont/config.yaml`, held to `specs/src/kb-identity/ProjectConfig.json`,
//! or the TOML `.semiont/config` where a knowledge base still has that one.

use serde_json::Value;
use std::path::Path;

/// The project file's schema. The launcher holds the file to it too.
const PROJECT_CONFIG_SCHEMA: &str =
    include_str!("../../../../specs/src/kb-identity/ProjectConfig.json");

/// The keys of the committed project file the Archivist reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Committed {
    /// The project's name, or the root directory's name where a TOML file
    /// names none.
    pub name: String,
    /// The site's domain: the knowledge base's identity.
    pub domain: Option<String>,
    /// Whether changes are staged in git: true only when it is the literal
    /// `true`.
    pub git_sync: bool,
}

/// The committed project file of the tree at `root`. A `config.yaml` that does
/// not hold to its schema is refused, each place named. Without one, the TOML
/// file is read, and a TOML file that is absent or does not parse reads as
/// every key absent.
pub fn committed(root: &Path) -> Result<Committed, String> {
    let yaml = root.join(".semiont").join("config.yaml");
    match std::fs::read_to_string(&yaml) {
        Ok(text) => from_yaml(&yaml, &text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(from_toml(root)),
        Err(e) => Err(format!("Cannot read {}: {e}", yaml.display())),
    }
}

fn from_yaml(path: &Path, text: &str) -> Result<Committed, String> {
    let where_ = path.display();
    let document: Value =
        serde_saphyr::from_str(text).map_err(|e| format!("{where_} is not YAML: {e}"))?;
    let schema: Value = serde_json::from_str(PROJECT_CONFIG_SCHEMA)
        .map_err(|e| format!("ProjectConfig.json is not JSON: {e}"))?;
    let validator = jsonschema::options()
        .with_draft(jsonschema::Draft::Draft202012)
        .build(&schema)
        .map_err(|e| format!("ProjectConfig.json does not compile: {e}"))?;
    let refusals: Vec<String> = validator
        .iter_errors(&document)
        .map(|error| {
            let at = error.instance_path().to_string();
            let at = if at.is_empty() { "/".to_owned() } else { at };
            format!("{at} {error}")
        })
        .collect();
    if !refusals.is_empty() {
        return Err(format!(
            "{where_} does not hold to its schema (specs/src/kb-identity/ProjectConfig.json): {}",
            refusals.join("; ")
        ));
    }
    let text_at = |section: &str, key: &str| {
        document[section][key]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| format!("{where_} states no {section}.{key}"))
    };
    Ok(Committed {
        name: text_at("project", "name")?,
        domain: Some(text_at("site", "domain")?),
        git_sync: document["git"]["sync"].as_bool() == Some(true),
    })
}

fn from_toml(root: &Path) -> Committed {
    let table = std::fs::read_to_string(root.join(".semiont").join("config"))
        .ok()
        .and_then(|text| text.parse::<toml::Table>().ok())
        .unwrap_or_default();
    let text = |section: &str, key: &str| {
        table
            .get(section)
            .and_then(|s| s.get(key))
            .and_then(|v| v.as_str())
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
    };
    Committed {
        name: text("project", "name").unwrap_or_else(|| {
            root.file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default()
        }),
        domain: text("site", "domain"),
        git_sync: table
            .get("git")
            .and_then(|s| s.get("sync"))
            .and_then(|v| v.as_bool())
            == Some(true),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tree(files: &[(&str, &str)]) -> PathBuf {
        let root = std::env::temp_dir().join(format!("kb-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join(".semiont")).unwrap();
        for (name, text) in files {
            std::fs::write(root.join(".semiont").join(name), text).unwrap();
        }
        root
    }

    const YAML: &str = "project:\n  name: Test Knowledge Base\ngit:\n  sync: true\nsite:\n  domain: example.github.io:test-kb\n  siteName: Test Knowledge Base\n";
    const TOML: &str = "[project]\nname = \"Other\"\n\n[git]\nsync = false\n\n[site]\ndomain = \"example.org:other\"\n";

    #[test]
    fn config_yaml_is_read_before_the_toml() {
        let root = tree(&[("config.yaml", YAML), ("config", TOML)]);
        assert_eq!(
            committed(&root),
            Ok(Committed {
                name: "Test Knowledge Base".to_owned(),
                domain: Some("example.github.io:test-kb".to_owned()),
                git_sync: true,
            })
        );
    }

    #[test]
    fn the_toml_is_read_where_there_is_no_config_yaml() {
        let root = tree(&[("config", TOML)]);
        assert_eq!(
            committed(&root),
            Ok(Committed {
                name: "Other".to_owned(),
                domain: Some("example.org:other".to_owned()),
                git_sync: false,
            })
        );
    }

    #[test]
    fn a_config_yaml_that_does_not_hold_is_refused_naming_where() {
        let misspelled = YAML.replace("  domain:", "  domian:");
        let root = tree(&[("config.yaml", &misspelled)]);
        let refusal = committed(&root).expect_err("a misspelled domain must be refused");
        assert!(refusal.contains("/site"), "{refusal}");
        assert!(refusal.contains("domian"), "{refusal}");
    }

    #[test]
    fn a_sync_written_as_text_is_refused() {
        let root = tree(&[("config.yaml", &YAML.replace("sync: true", "sync: \"yes\""))]);
        let refusal = committed(&root).expect_err("a sync written as text must be refused");
        assert!(refusal.contains("/git/sync"), "{refusal}");
    }
}
