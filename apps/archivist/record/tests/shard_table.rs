//! Runs every case of specs/src/archivist/shard-cases.json through this
//! crate's reading of where a key is filed. TypeScript, which the Librarian
//! and the Smelter read and write the same files with, runs the same table
//! (packages/core shard-agreement.test.ts).

use semiont_archivist_record::shard::shard_path;
use serde::Deserialize;

#[derive(Deserialize)]
struct Table {
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    why: String,
    key: String,
    shard: String,
}

#[test]
fn every_key_is_filed_where_the_shared_table_says() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../specs/src/archivist/shard-cases.json"
    );
    let table: Table =
        serde_json::from_str(&std::fs::read_to_string(path).expect("the shard table is in specs/"))
            .expect("the shard table is JSON of cases");
    assert!(
        !table.cases.is_empty(),
        "the shard table has no cases: a gate that runs nothing passes on silence"
    );
    for case in table.cases {
        let (ab, cd) = shard_path(&case.key);
        assert_eq!(format!("{ab}/{cd}"), case.shard, "{}", case.why);
    }
}
