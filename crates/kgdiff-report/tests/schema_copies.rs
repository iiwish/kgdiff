//! The JSON Schema validator of the tests is one file in two crates (see its header): this fails
//! when the copies differ.

#[test]
fn the_validator_of_kgdiff_layout_is_a_copy_of_this_one() {
    let read = |krate: &str| {
        let path = format!(
            "{}/../{krate}/tests/support/schema.rs",
            env!("CARGO_MANIFEST_DIR")
        );
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
    };
    assert!(
        read("kgdiff-report") == read("kgdiff-layout"),
        "crates/kgdiff-report/tests/support/schema.rs and \
         crates/kgdiff-layout/tests/support/schema.rs must be identical"
    );
}
