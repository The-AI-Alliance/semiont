//! A README's examples, held to source that compiles. A test marks regions
//! of its own source, runs them, and asserts that the README's fenced Rust
//! blocks are those regions word for word: an example that stops compiling
//! or stops doing what it says fails a test, and a block edited by hand in
//! the README fails this.
//!
//! A region is the lines between `// <readme:NAME>` and `// </readme:NAME>`,
//! less their common indentation.

use std::collections::BTreeMap;

/// The regions marked in `source`, by name.
fn regions(source: &str) -> Result<BTreeMap<String, String>, String> {
    let mut found = BTreeMap::new();
    let mut open: Option<(String, Vec<&str>)> = None;
    for line in source.lines() {
        let marker = line.trim();
        if let Some(name) = marker
            .strip_prefix("// <readme:")
            .and_then(|rest| rest.strip_suffix('>'))
        {
            if let Some((unclosed, _)) = &open {
                return Err(format!("region \"{name}\" opens inside \"{unclosed}\""));
            }
            open = Some((name.to_owned(), Vec::new()));
        } else if let Some(name) = marker
            .strip_prefix("// </readme:")
            .and_then(|rest| rest.strip_suffix('>'))
        {
            match open.take() {
                Some((opened, lines)) if opened == name => {
                    if found.insert(opened, dedented(&lines)).is_some() {
                        return Err(format!("region \"{name}\" is marked twice"));
                    }
                }
                _ => return Err(format!("region \"{name}\" closes without opening")),
            }
        } else if let Some((_, lines)) = &mut open {
            lines.push(line);
        }
    }
    match open {
        Some((unclosed, _)) => Err(format!("region \"{unclosed}\" is never closed")),
        None => Ok(found),
    }
}

fn dedented(lines: &[&str]) -> String {
    let indent = lines
        .iter()
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.len() - line.trim_start().len())
        .min()
        .unwrap_or(0);
    lines
        .iter()
        .map(|line| line.get(indent..).unwrap_or("").trim_end())
        .collect::<Vec<_>>()
        .join("\n")
}

/// The fenced Rust blocks of a Markdown document, in order. A block inside
/// a list is indented by the list, and is read without that indentation.
fn rust_blocks(markdown: &str) -> Vec<String> {
    let mut blocks = Vec::new();
    let mut open: Option<Vec<&str>> = None;
    for line in markdown.lines() {
        match &mut open {
            None if line.trim() == "```rust" => open = Some(Vec::new()),
            None => {}
            Some(lines) if line.trim() == "```" => {
                blocks.push(dedented(lines));
                open = None;
            }
            Some(lines) => lines.push(line),
        }
    }
    blocks
}

/// Fail unless every fenced Rust block of `readme` is one of the regions
/// marked in `sources`, word for word, and every region is shown. The
/// failure says which block, or which region, is the odd one.
pub fn assert_readme_shows(readme: &str, sources: &[&str]) -> Result<(), String> {
    let mut marked = BTreeMap::new();
    for source in sources {
        for (name, text) in regions(source)? {
            if marked.insert(name.clone(), text).is_some() {
                return Err(format!("region \"{name}\" is marked twice"));
            }
        }
    }
    let blocks = rust_blocks(readme);
    for block in &blocks {
        if !marked.values().any(|region| region == block) {
            return Err(format!(
                "a Rust block of the README is not an example that is compiled and run:\n{block}"
            ));
        }
    }
    for (name, region) in &marked {
        if !blocks.contains(region) {
            return Err(format!(
                "the example \"{name}\" is not shown in the README:\n{region}"
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOURCE: &str = "fn a() {\n    // <readme:one>\n    let x = 1;\n\n    if x == 1 {\n        go();\n    }\n    // </readme:one>\n}\n";

    #[test]
    fn a_readme_that_shows_each_region_word_for_word_passes() {
        let readme = "Text.\n\n```rust\nlet x = 1;\n\nif x == 1 {\n    go();\n}\n```\n\n```bash\ncargo test\n```\n";
        assert_eq!(assert_readme_shows(readme, &[SOURCE]), Ok(()));
        // A block inside a list is indented by the list.
        let listed =
            "- An item:\n\n  ```rust\n  let x = 1;\n\n  if x == 1 {\n      go();\n  }\n  ```\n";
        assert_eq!(assert_readme_shows(listed, &[SOURCE]), Ok(()));
    }

    #[test]
    fn a_block_that_is_no_region_and_a_region_that_is_not_shown_both_fail() {
        let edited = "```rust\nlet x = 2;\n\nif x == 1 {\n    go();\n}\n```\n";
        let failure = assert_readme_shows(edited, &[SOURCE]).expect_err("the block was edited");
        assert!(
            failure.starts_with("a Rust block of the README is not"),
            "{failure}"
        );
        assert!(failure.contains("let x = 2;"), "{failure}");

        let silent = "No code here.\n";
        let failure = assert_readme_shows(silent, &[SOURCE]).expect_err("nothing is shown");
        assert!(
            failure.starts_with("the example \"one\" is not shown"),
            "{failure}"
        );
    }

    #[test]
    fn markers_that_do_not_pair_are_said() {
        for (source, said) in [
            ("// <readme:a>\nx\n", "region \"a\" is never closed"),
            ("// </readme:a>\n", "region \"a\" closes without opening"),
            (
                "// <readme:a>\n// <readme:b>\n",
                "region \"b\" opens inside \"a\"",
            ),
            (
                "// <readme:a>\n// </readme:a>\n// <readme:a>\n// </readme:a>\n",
                "region \"a\" is marked twice",
            ),
        ] {
            assert_eq!(assert_readme_shows("", &[source]), Err(said.to_owned()));
        }
    }
}
