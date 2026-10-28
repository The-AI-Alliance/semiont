//! What a knowledge base says of itself: its committed project file,
//! `.semiont/config.yaml`, held to `specs/src/kb-identity/ProjectConfig.json`.

use serde_json::Value;
use std::path::Path;

/// The project file's schema. The launcher holds the file to it too.
const PROJECT_CONFIG_SCHEMA: &str =
    include_str!("../../../../specs/src/kb-identity/ProjectConfig.json");

/// The keys of the committed project file the Archivist reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Committed {
    /// The project's name, or the root directory's name where the knowledge
    /// base commits no project file.
    pub name: String,
    /// The site's domain: the knowledge base's identity. None only where the
    /// knowledge base commits no project file.
    pub domain: Option<String>,
    /// Whether changes are staged in git.
    pub git_sync: bool,
}

/// The committed project file of the tree at `root`. One that does not hold to
/// its schema is refused, each place named; a tree without one is named by its
/// directory, and declares no identity.
pub fn committed(root: &Path) -> Result<Committed, String> {
    let yaml = root.join(".semiont").join("config.yaml");
    match std::fs::read_to_string(&yaml) {
        Ok(text) => from_yaml(&yaml, &text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Committed {
            name: root
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .ok_or_else(|| format!("{} names no directory", root.display()))?,
            domain: None,
            git_sync: false,
        }),
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
    let git_sync = document["git"]["sync"]
        .as_bool()
        .ok_or_else(|| format!("{where_} states no git.sync"))?;
    Ok(Committed {
        name: text_at("project", "name")?,
        domain: Some(text_at("site", "domain")?),
        git_sync,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tree(dir: &str, config: Option<&str>) -> PathBuf {
        let root = std::env::temp_dir()
            .join(format!("kb-{}", uuid::Uuid::new_v4()))
            .join(dir);
        std::fs::create_dir_all(root.join(".semiont")).unwrap();
        if let Some(text) = config {
            std::fs::write(root.join(".semiont").join("config.yaml"), text).unwrap();
        }
        root
    }

    /// Every case of specs/src/kb-identity/cases.json, as the launcher runs
    /// them: a project file the case refuses is refused, and every other
    /// yields the name and domain the case states.
    #[test]
    fn every_identity_case_is_read_as_it_says() {
        let table: Value =
            serde_json::from_str(include_str!("../../../../specs/src/kb-identity/cases.json"))
                .unwrap();
        let (mut refused, mut read) = (0, 0);
        for case in table["cases"].as_array().expect("the table has cases") {
            let why = case["why"].as_str().expect("a case says why");
            let root = tree(
                case["dir"].as_str().expect("a case names its directory"),
                case["config"].as_str(),
            );
            let got = committed(&root);
            if case["refused"]
                .as_bool()
                .expect("a case says whether it is refused")
            {
                refused += 1;
                assert!(
                    got.is_err(),
                    "{why}: read a project file the case refuses: {got:?}"
                );
                continue;
            }
            read += 1;
            let got =
                got.unwrap_or_else(|e| panic!("{why}: refused a project file the case reads: {e}"));
            assert_eq!(Some(got.name.as_str()), case["name"].as_str(), "{why}");
            assert_eq!(got.domain.as_deref(), case["domain"].as_str(), "{why}");
        }
        assert!(
            refused > 0 && read > 0,
            "the table has {refused} refused and {read} read cases: a gate that runs nothing on one side passes on silence"
        );
    }

    const YAML: &str = "project:\n  name: Test Knowledge Base\ngit:\n  sync: true\nsite:\n  domain: example.github.io:test-kb\n  siteName: Test Knowledge Base\n";

    #[test]
    fn a_config_yaml_that_does_not_hold_is_refused_naming_where() {
        let misspelled = YAML.replace("  domain:", "  domian:");
        let root = tree("misspelled-kb", Some(&misspelled));
        let refusal = committed(&root).expect_err("a misspelled domain must be refused");
        assert!(refusal.contains("/site"), "{refusal}");
        assert!(refusal.contains("domian"), "{refusal}");
    }

    #[test]
    fn git_sync_is_read() {
        let root = tree(
            "unsynced-kb",
            Some(&YAML.replace("sync: true", "sync: false")),
        );
        assert!(!committed(&root).unwrap().git_sync);
        let root = tree("synced-kb", Some(YAML));
        assert!(committed(&root).unwrap().git_sync);
    }
}
